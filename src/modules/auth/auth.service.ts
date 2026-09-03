// backend/src/modules/auth/auth.service.ts
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../../config/prisma";
import { consumeDigitalIdVerificationToken, DigitalIdValidationError } from "./digitalId.service";

const JWT_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || "superlongrandomaccesssecret";
const JWT_EXPIRES = process.env.JWT_ACCESS_EXPIRES || "7d";

interface GoogleTokenPayload {
  aud: string;
  email: string;
  name: string;
  picture?: string;
  sub: string;
}

interface DigitalIdVerificationForUser {
  verifiedAt: Date;
  method: string;
}

interface GoogleLoginOptions {
  digitalIdVerificationToken?: string;
  allowSignup?: boolean;
}

export class AuthenticationError extends Error {
  statusCode: number;
  status: number;
  code: string;

  constructor(message = "Unable to sign in.", statusCode = 401, code = "AUTH_FAILED") {
    super(message);
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
  }
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Role names are stored in mixed case ("USER", "ADMIN", "SUPER_ADMIN").
 *  This helper normalises before comparison so nothing breaks if the DB
 *  ever has an inconsistency. */
const isAdminRole = (name: string) =>
  name.toUpperCase() === "ADMIN" || name.toUpperCase() === "SUPER_ADMIN";

const findOrCreateRole = async (roleName: string) => {
  // Prefer exact match, then case-insensitive fallback
  let role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) {
    // Try uppercase version (handles seed data inconsistency)
    role = await prisma.role.findFirst({
      where: { name: { equals: roleName, mode: "insensitive" } },
    });
  }
  if (!role) throw new Error(`Role "${roleName}" not found. Run the seed script first.`);
  return role;
};

export const registerUser = async (
  email: string,
  password: string,
  roleName = "USER",
  fullName?: string,
  digitalIdVerification?: DigitalIdVerificationForUser
) => {
  const normalizedEmail = normalizeEmail(email);

  // Friendly duplicate-email check before hitting the unique constraint
  const existing = await prisma.user.findFirst({
    where: { email: { equals: normalizedEmail, mode: "insensitive" } },
  });
  if (existing) throw new Error("An account with this email already exists. Please log in instead.");

  const hashedPassword = await bcrypt.hash(password, 12);
  const role = await findOrCreateRole(roleName);

  const usernameBase = normalizedEmail.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "");
  let username = usernameBase;
  let suffix = 1;
  while (await prisma.user.findUnique({ where: { username } })) {
    username = `${usernameBase}${suffix++}`;
  }

  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash: hashedPassword,
      fullName: fullName || username,
      username,
      isVerified: true,
      digitalIdStatus: digitalIdVerification ? "PASSED" : "PENDING",
      digitalIdVerifiedAt: digitalIdVerification?.verifiedAt || null,
      digitalIdVerificationMethod: digitalIdVerification?.method || null,
      roles: { create: { roleId: role.id } },
    },
    include: { roles: { include: { role: true } } },
  });

  return user;
};

export const isEmailRegistered = async (email: string) => {
  const user = await prisma.user.findFirst({
    where: { email: { equals: normalizeEmail(email), mode: "insensitive" } },
  });
  return Boolean(user);
};

export const loginUser = async (email: string, password: string) => {
  const user = await prisma.user.findFirst({
    where: { email: { equals: normalizeEmail(email), mode: "insensitive" } },
    include: { roles: { include: { role: true } } },
  });

  if (!user) throw new AuthenticationError("Incorrect email or password.", 401, "INVALID_CREDENTIALS");

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) throw new AuthenticationError("Incorrect email or password.", 401, "INVALID_CREDENTIALS");

  const roleNames = user.roles.map((r) => r.role.name);
  const payload = {
    userId: user.id,
    email: user.email,
    roles: roleNames,
    isAdmin: roleNames.some(isAdminRole),
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES } as any);
  return { user, token };
};

export const loginWithGoogle = async (idToken: string, options: GoogleLoginOptions = {}) => {
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );
  if (!response.ok) throw new AuthenticationError("Unable to sign in with Google.", 401, "INVALID_GOOGLE_TOKEN");

  const gPayload = (await response.json()) as GoogleTokenPayload;
  if (GOOGLE_CLIENT_ID && gPayload.aud !== GOOGLE_CLIENT_ID) {
    throw new AuthenticationError("Unable to sign in with Google.", 401, "GOOGLE_AUDIENCE_MISMATCH");
  }

  const { name: fullName = "", picture } = gPayload;
  const email = gPayload.email ? normalizeEmail(gPayload.email) : "";
  if (!email) throw new AuthenticationError("Unable to sign in with Google.", 401, "GOOGLE_EMAIL_MISSING");

  let user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    include: { roles: { include: { role: true } } },
  });

  if (!user) {
    if (!options.allowSignup) {
      throw new AuthenticationError(
        "No account found for this Google sign-in. Please create an account first.",
        404,
        "GOOGLE_ACCOUNT_NOT_FOUND"
      );
    }

    const digitalIdVerification = consumeDigitalIdVerificationToken(options.digitalIdVerificationToken, email);
    if (!digitalIdVerification) {
      throw new DigitalIdValidationError(
        "Digital ID verification is required before creating a new account.",
        400,
        "DIGITAL_ID_REQUIRED"
      );
    }

    const userRole = await findOrCreateRole("USER");
    const randomPass = Math.random().toString(36).slice(-12);
    const hashed = await bcrypt.hash(randomPass, 12);
    const usernameBase = email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "");
    let username = usernameBase;
    let suffix = 1;
    while (await prisma.user.findUnique({ where: { username } })) {
      username = `${usernameBase}${suffix++}`;
    }

    user = await prisma.user.create({
      data: {
        email,
        fullName: fullName || usernameBase,
        username,
        passwordHash: hashed,
        profileImageUrl: picture,
        isVerified: true,
        digitalIdStatus: "PASSED",
        digitalIdVerifiedAt: digitalIdVerification.verifiedAt,
        digitalIdVerificationMethod: digitalIdVerification.method,
        roles: { create: { roleId: userRole.id } },
      },
      include: { roles: { include: { role: true } } },
    });
  }

  const roleNames = user.roles.map((r) => r.role.name);
  const payload = {
    userId: user.id,
    email: user.email,
    roles: roleNames,
    isAdmin: roleNames.some(isAdminRole),
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES } as any);
  return { user, token };
};
