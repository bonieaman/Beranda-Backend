// src/modules/auth/auth.routes.ts
import { Router } from "express";
import multer from "multer";
import {
  DIGITAL_ID_MAX_FILE_SIZE_BYTES,
  DIGITAL_ID_UPLOAD_FIELD,
} from "./digitalId.service";
import { register, login, googleLogin, verifyDigitalId } from "./auth.controller";

const router = Router();
const allowedDigitalIdMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

const digitalIdUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: DIGITAL_ID_MAX_FILE_SIZE_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (allowedDigitalIdMimeTypes.has(file.mimetype)) {
      cb(null, true);
      return;
    }

    cb(new Error("UNSUPPORTED_DIGITAL_ID_IMAGE"));
  },
});

const handleDigitalIdUpload = (req: any, res: any, next: any) => {
  digitalIdUpload.single(DIGITAL_ID_UPLOAD_FIELD)(req, res, (err: any) => {
    if (!err) return next();

    const message =
      err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
        ? "Digital ID image must be 5 MB or smaller."
        : "Please upload a JPG, PNG, or WebP image of your Digital ID.";

    return res.status(400).json({ success: false, message });
  });
};

router.post("/digital-id/verify", handleDigitalIdUpload, verifyDigitalId);
router.post("/register", register);
router.post("/login", login);
router.post("/google", googleLogin);

export default router;
