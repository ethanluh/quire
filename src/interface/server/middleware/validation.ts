import type { Request, Response, NextFunction } from "express";
import { type ZodSchema } from "zod";

export function validateBody<T>(schema: ZodSchema<T>) {
	return (req: Request, res: Response, next: NextFunction): void => {
		const result = schema.safeParse(req.body);
		if (!result.success) {
			res.status(400).json({ error: "Invalid request body", details: result.error.errors });
			return;
		}
		req.body = result.data;
		next();
	};
}
