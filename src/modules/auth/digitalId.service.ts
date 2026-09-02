import crypto from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const DIGITAL_ID_UPLOAD_FIELD = "digitalIdImage";
export const DIGITAL_ID_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

const MIN_FILE_SIZE_BYTES = 12 * 1024;
const MIN_WIDTH = 600;
const MIN_HEIGHT = 350;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 6;
const OCR_MODEL = process.env.DIGITAL_ID_OCR_MODEL || "gemini-2.5-flash";
const OCR_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.DIGITAL_ID_OCR_TIMEOUT_MS) || 12000, 1000),
  30000
);
const DIGITAL_ID_VERIFICATION_MODE =
  process.env.DIGITAL_ID_VERIFICATION_MODE ||
  (process.env.NODE_ENV === "test" || process.env.CI === "true" ? "local-image-check" : "ocr");

type ImageKind = "image/jpeg" | "image/png" | "image/webp";

interface DigitalIdUploadFile {
  buffer: Buffer;
  size: number;
}

interface GeminiDigitalIdAnalysis {
  documentType?: string;
  readable?: boolean;
  isSelfieOrUnrelatedPhoto?: boolean;
  hasEthiopianContext?: boolean;
  hasDigitalIdTerminology?: boolean;
  hasIdentityFields?: boolean;
  hasIdNumberPattern?: boolean;
  hasDateFields?: boolean;
  confidence?: number;
  visibleTextSample?: string;
}

interface VerificationRecord {
  email: string;
  expiresAt: number;
  verifiedAt: Date;
  method: string;
}

export class DigitalIdValidationError extends Error {
  statusCode: number;
  status: number;
  code: string;

  constructor(message: string, statusCode = 400, code = "DIGITAL_ID_REJECTED") {
    super(message);
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
  }
}

const attemptsByKey = new Map<string, number[]>();
const passedVerifications = new Map<string, VerificationRecord>();

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const pruneExpiredVerificationTokens = () => {
  const now = Date.now();
  for (const [token, record] of passedVerifications.entries()) {
    if (record.expiresAt < now) passedVerifications.delete(token);
  }
};

export const assertDigitalIdAttemptAllowed = (key: string) => {
  const now = Date.now();
  const attempts = (attemptsByKey.get(key) || []).filter((ts) => now - ts < ATTEMPT_WINDOW_MS);

  if (attempts.length >= MAX_ATTEMPTS_PER_WINDOW) {
    throw new DigitalIdValidationError(
      "Too many Digital ID verification attempts. Please wait a few minutes and try again.",
      429,
      "RATE_LIMITED"
    );
  }

  attempts.push(now);
  attemptsByKey.set(key, attempts);
};

const detectImageKind = (buffer: Buffer): ImageKind | null => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
};

const readUInt24LE = (buffer: Buffer, offset: number) =>
  buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16);

const getImageDimensions = (buffer: Buffer, kind: ImageKind) => {
  if (kind === "image/png" && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (kind === "image/jpeg") {
    let offset = 2;
    while (offset + 3 < buffer.length) {
      while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
      if (offset + 3 >= buffer.length) break;

      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0x01) {
        offset += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break;

      const size = buffer.readUInt16BE(offset + 2);
      if (size < 2 || offset + 2 + size > buffer.length) break;

      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
        };
      }

      offset += 2 + size;
    }
  }

  if (kind === "image/webp" && buffer.length >= 30) {
    const chunk = buffer.toString("ascii", 12, 16);

    if (chunk === "VP8X") {
      return {
        width: readUInt24LE(buffer, 24) + 1,
        height: readUInt24LE(buffer, 27) + 1,
      };
    }

    if (chunk === "VP8L" && buffer.length >= 25) {
      return {
        width: 1 + (((buffer[22] & 0x3f) << 8) | buffer[21]),
        height: 1 + (((buffer[24] & 0x0f) << 10) | (buffer[23] << 2) | ((buffer[22] & 0xc0) >> 6)),
      };
    }

    if (chunk === "VP8 " && buffer.length >= 30) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
  }

  return null;
};

const validateImage = (file: DigitalIdUploadFile) => {
  if (!file?.buffer || file.buffer.length === 0) {
    throw new DigitalIdValidationError("Please upload a clear image of your Digital ID.");
  }

  if (file.size > DIGITAL_ID_MAX_FILE_SIZE_BYTES) {
    throw new DigitalIdValidationError("Digital ID image must be 5 MB or smaller.");
  }

  if (file.size < MIN_FILE_SIZE_BYTES) {
    throw new DigitalIdValidationError(
      "We couldn't clearly read your Digital ID. Please upload a clearer image showing the entire ID."
    );
  }

  const kind = detectImageKind(file.buffer);
  if (!kind) {
    throw new DigitalIdValidationError("Please upload a JPG, PNG, or WebP image of your Digital ID.");
  }

  const dimensions = getImageDimensions(file.buffer, kind);
  if (!dimensions || dimensions.width < MIN_WIDTH || dimensions.height < MIN_HEIGHT) {
    throw new DigitalIdValidationError(
      "We couldn't clearly read your Digital ID. Please upload a clearer image showing the entire ID."
    );
  }

  return { kind, dimensions };
};

const extractJson = (text: string): GeminiDigitalIdAnalysis => {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const json = cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned;
  return JSON.parse(json) as GeminiDigitalIdAnalysis;
};

const normalizeText = (value: unknown) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const countMatches = (text: string, patterns: RegExp[]) =>
  patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);

const useLocalImageCheckOnly = () =>
  ["local", "local-image-check", "image-precheck"].includes(DIGITAL_ID_VERIFICATION_MODE.toLowerCase());

const timeoutAfter = <T>(promise: Promise<T>, timeoutMs: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new DigitalIdValidationError(
            "Digital ID screening is temporarily unavailable. Please try again later.",
            503,
            "OCR_TIMEOUT"
          )
        ),
      timeoutMs
    );

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

const scoreDigitalIdAnalysis = (analysis: GeminiDigitalIdAnalysis) => {
  const text = normalizeText(analysis.visibleTextSample);
  const confidence = typeof analysis.confidence === "number" ? Math.max(0, Math.min(1, analysis.confidence)) : 0;
  const documentType = normalizeText(analysis.documentType);

  const documentSignals = countMatches(text, [
    /\bethiopia(n)?\b/,
    /\bfederal democratic republic\b/,
    /\bfdre\b/,
    /\bnational digital id\b/,
    /\bnational id\b/,
    /\bdigital id\b/,
    /\bfayda\b/,
    /\bfida\b/,
    /[\u1200-\u137f].*(መታወቂያ|ፋይዳ|ኢትዮጵያ)/,
  ]);
  const identityFieldSignals = countMatches(text, [
    /\bfull name\b/,
    /\bgiven name\b/,
    /\bsurname\b/,
    /\bdate of birth\b/,
    /\bdob\b/,
    /\bnationality\b/,
    /\bsex\b/,
    /\bgender\b/,
    /\bfin\b/,
    /\bfan\b/,
    /\bid no\b/,
    /\bid number\b/,
    /\bexpiry\b/,
    /\bissue\b/,
    /[\u1200-\u137f]/,
  ]);
  const wrongDocumentSignals =
    /\b(selfie|portrait|driver'?s?\s+licen[cs]e|passport|bank\s+card|credit\s+card|debit\s+card|student\s+id)\b/.test(
      `${documentType} ${text}`
    );
  const hasIdPattern =
    Boolean(analysis.hasIdNumberPattern) ||
    /\b(?:fin|fan|id|uin|number|no\.?)?\s*[:#-]?\s*\d(?:[\d -]{7,}\d)\b/i.test(text);
  const hasDatePattern =
    Boolean(analysis.hasDateFields) ||
    /\b(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/.test(text) ||
    /\b\d{1,2}[-/.]\d{1,2}[-/.](?:19|20)\d{2}\b/.test(text);

  let score = 0;
  if (documentType.includes("ethiopian") || documentType.includes("digital_id") || documentType.includes("fayda")) score += 22;
  if (analysis.readable) score += 12;
  if (analysis.hasEthiopianContext || documentSignals >= 1) score += 14;
  if (analysis.hasDigitalIdTerminology || documentSignals >= 2) score += 14;
  if (analysis.hasIdentityFields || identityFieldSignals >= 2) score += 14;
  if (hasIdPattern) score += 10;
  if (hasDatePattern) score += 6;
  if (text.length >= 80) score += 8;
  score += Math.round(confidence * 10);

  const hasMinimumSignals =
    (analysis.hasEthiopianContext || documentSignals >= 1) &&
    (analysis.hasDigitalIdTerminology || documentSignals >= 2) &&
    (analysis.hasIdentityFields || identityFieldSignals >= 2) &&
    (hasIdPattern || hasDatePattern);

  return {
    score,
    accepted:
      score >= 65 &&
      Boolean(analysis.readable) &&
      hasMinimumSignals &&
      !analysis.isSelfieOrUnrelatedPhoto &&
      !wrongDocumentSignals,
    tooLittleText: text.length < 30,
  };
};

const analyzeWithGemini = async (file: DigitalIdUploadFile, mimeType: ImageKind) => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "";

  if (!apiKey) {
    throw new DigitalIdValidationError(
      "Digital ID screening is temporarily unavailable. Please try again later.",
      503,
      "OCR_UNAVAILABLE"
    );
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: OCR_MODEL,
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 180,
        responseMimeType: "application/json",
      } as any,
    });

    const result = await timeoutAfter(model.generateContent([
      {
        text: [
          "You are screening an uploaded image for Berenda account signup.",
          "Determine whether it appears to be an Ethiopian Digital ID/Fayda-style national digital identification document.",
          "This is document screening only, not proof of authenticity or ownership.",
          "Reject selfies, driver licenses, passports, bank cards, and unrelated documents.",
          "Do not include full government ID numbers or sensitive personal data in the response.",
          "Return JSON only with these keys:",
          "documentType, readable, isSelfieOrUnrelatedPhoto, hasEthiopianContext, hasDigitalIdTerminology, hasIdentityFields, hasIdNumberPattern, hasDateFields, confidence, visibleTextSample.",
          "visibleTextSample must be under 12 words and include non-sensitive labels/terms only, with long numbers masked.",
        ].join(" "),
      },
      {
        inlineData: {
          mimeType,
          data: file.buffer.toString("base64"),
        },
      },
    ]), OCR_TIMEOUT_MS);

    return extractJson(result.response.text());
  } catch (error) {
    if (error instanceof DigitalIdValidationError) throw error;

    throw new DigitalIdValidationError(
      "Digital ID screening is temporarily unavailable. Please try again later.",
      503,
      "OCR_UNAVAILABLE"
    );
  }
};

const createVerificationToken = (email: string, method: string) => {
  pruneExpiredVerificationTokens();

  const token = crypto.randomBytes(32).toString("hex");
  passedVerifications.set(token, {
    email: normalizeEmail(email),
    expiresAt: Date.now() + TOKEN_TTL_MS,
    verifiedAt: new Date(),
    method,
  });
  return token;
};

export const verifyDigitalIdImage = async (file: DigitalIdUploadFile, email: string) => {
  if (!email || !email.trim()) {
    throw new DigitalIdValidationError("Please enter your email before verifying your Digital ID.");
  }

  const { kind } = validateImage(file);

  if (useLocalImageCheckOnly()) {
    return {
      status: "PASSED" as const,
      verificationToken: createVerificationToken(email, "LOCAL_IMAGE_PRECHECK"),
      expiresInSeconds: Math.floor(TOKEN_TTL_MS / 1000),
      message: "Digital ID image precheck passed.",
    };
  }

  const analysis = await analyzeWithGemini(file, kind);
  const scoring = scoreDigitalIdAnalysis(analysis);

  if (scoring.tooLittleText || !analysis.readable) {
    throw new DigitalIdValidationError(
      "We couldn't clearly read your Digital ID. Please upload a clearer image showing the entire ID."
    );
  }

  if (!scoring.accepted) {
    throw new DigitalIdValidationError(
      "We couldn't recognize this as a supported Digital ID. Please upload a clear image of your Digital ID."
    );
  }

  return {
    status: "PASSED" as const,
    verificationToken: createVerificationToken(email, "GEMINI_OCR_DOCUMENT_SCREENING"),
    expiresInSeconds: Math.floor(TOKEN_TTL_MS / 1000),
    message: "Digital ID document screening passed.",
  };
};

export const consumeDigitalIdVerificationToken = (token: string | undefined, email: string) => {
  pruneExpiredVerificationTokens();

  if (!token) return null;

  const record = passedVerifications.get(token);
  if (!record) return null;

  passedVerifications.delete(token);

  if (record.expiresAt < Date.now()) return null;
  if (record.email !== normalizeEmail(email)) return null;

  return {
    verifiedAt: record.verifiedAt,
    method: record.method,
  };
};
