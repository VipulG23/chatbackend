import { Response, NextFunction, RequestHandler } from "express";
import { AuthenticatedRequest } from "../middlewares/isAuth.js"; // ✅ Use your custom type

const TryCatch = (
  handler: (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) => Promise<any>
): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(handler(req as AuthenticatedRequest, res, next)).catch(
      (error) => {
        res.status(500).json({
          message: error?.message || "Internal Server Error",
        });
      }
    );
  };
};

export default TryCatch;
