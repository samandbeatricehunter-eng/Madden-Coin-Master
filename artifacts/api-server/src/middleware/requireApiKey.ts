import type { Request, Response, NextFunction } from "express";

const API_KEY = process.env["MADDEN_WEBHOOK_KEY"] ?? "";

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!API_KEY) {
    res.status(500).json({ error: "Server misconfigured: API key not set" });
    return;
  }

  if (!token || token !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
