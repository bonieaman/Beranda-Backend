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
  // Friendly duplicate-email check before hitting the unique constraint
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new Error("An account with this email already exists. Please log in instead.");

  const hashedPassword = await bcrypt.hash(password, 12);
  const role = await findOrCreateRole(roleName);

  const usernameBase = email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "");
  let username = usernameBase;
  let suffix = 1;
  while (await prisma.user.findUnique({ where: { username } })) {
    username = `${usernameBase}${suffix++}`;
  }

  const user = await prisma.user.create({
    data: {
      email,
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
  const user = await prisma.user.findUnique({ where: { email } });
  return Boolean(user);
};

export const loginUser = async (email: string, password: string) => {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { roles: { include: { role: true } } },
  });

  if (!user) throw new Error("Invalid credentials");

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) throw new Error("Invalid credentials");

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

export const loginWithGoogle = async (idToken: string, digitalIdVerificationToken?: string) => {
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );
  if (!response.ok) throw new Error("Invalid Google ID token");

  const gPayload = (await response.json()) as GoogleTokenPayload;
  if (GOOGLE_CLIENT_ID && gPayload.aud !== GOOGLE_CLIENT_ID) {
    throw new Error("Google ID token audience mismatch");
  }

  const { email, name: fullName = "", picture } = gPayload;
  if (!email) throw new Error("Google token did not contain email");

  let user = await prisma.user.findUnique({
    where: { email },
    include: { roles: { include: { role: true } } },
  });

  if (!user) {
    const digitalIdVerification = consumeDigitalIdVerificationToken(digitalIdVerificationToken, email);
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
