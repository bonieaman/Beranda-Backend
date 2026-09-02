// backend/src/modules/auth/auth.controller.ts
import { Request, Response, NextFunction } from "express";
import * as AuthService from "./auth.service";
import { sendResponse } from "../../utils/response";
import {
  assertDigitalIdAttemptAllowed,
  consumeDigitalIdVerificationToken,
  DigitalIdValidationError,
  verifyDigitalIdImage,
} from "./digitalId.service";

// Gmail-only validation for NEW registrations.
// Login intentionally skips this so existing admin/system accounts can log in.
const isGmailAddress = (email: string) =>
  /^[a-zA-Z0-9._%+\-]+@gmail\.com$/i.test(email.trim());

export const register = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, fullName, role, digitalIdVerificationToken } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    if (!isGmailAddress(email)) {
      return res.status(400).json({
        success: false,
        message: "Only Gmail addresses (@gmail.com) are accepted for registration",
      });
    }

    if (await AuthService.isEmailRegistered(email)) {
      return res.status(400).json({
        success: false,
        message: "An account with this email already exists. Please log in instead.",
      });
    }

    const digitalIdVerification = consumeDigitalIdVerificationToken(digitalIdVerificationToken, email);
    if (!digitalIdVerification) {
      return res.status(400).json({
        success: false,
        message: "Digital ID verification is required before creating an account.",
      });
    }

    const user = await AuthService.registerUser(
      email,
      password,
      role || "USER",
      fullName,
      digitalIdVerification
    );

    sendResponse(res, 201, "User registered", {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      isVerified: user.isVerified,
      digitalIdStatus: (user as any).digitalIdStatus,
      digitalIdVerifiedAt: (user as any).digitalIdVerifiedAt,
      roles: user.roles?.map((r) => ({ name: r.role.name })) || [],
    });
  } catch (err: any) {
    next(err);
  }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    // No Gmail restriction on login — system/admin accounts may use other domains.
    const { user, token } = await AuthService.loginUser(email, password);

    sendResponse(res, 200, "Login successful", {
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        username: user.username,
        phone: user.phone,
        profileImageUrl: user.profileImageUrl,
        isVerified: user.isVerified,
        digitalIdStatus: (user as any).digitalIdStatus,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        roles: user.roles?.map((r) => ({ name: r.role.name })) || [],
      },
    });
  } catch (err: any) {
    next(err);
  }
};

export const googleLogin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { idToken, digitalIdVerificationToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ success: false, message: "idToken is required" });
    }

    const { user, token } = await AuthService.loginWithGoogle(idToken, digitalIdVerificationToken);

    sendResponse(res, 200, "Login successful", {
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        username: user.username,
        phone: user.phone,
        profileImageUrl: user.profileImageUrl,
        isVerified: user.isVerified,
        digitalIdStatus: (user as any).digitalIdStatus,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        roles: user.roles?.map((r) => ({ name: r.role.name })) || [],
      },
    });
  } catch (err: any) {
    next(err);
  }
};

export const verifyDigitalId = async (req: Request, res: Response) => {
  try {
    assertDigitalIdAttemptAllowed(`${req.ip}:${req.body?.email || "unknown"}`);

    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a clear image of your Digital ID.",
      });
    }

    const result = await verifyDigitalIdImage(file, String(req.body.email || ""));

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    if (error instanceof DigitalIdValidationError) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Digital ID screening is temporarily unavailable. Please try again later.",
    });
  }
};
