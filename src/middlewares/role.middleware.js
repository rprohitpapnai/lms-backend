import { ApiError } from "../utils/ApiError.js";

const authorizeRoles = (...allowedRoles) => {

  return (req, res, next) => {

    // req.user comes from verifyJWT middleware
    if (!req.user) {
      return next(
        new ApiError(401, "Unauthorized request")
      );
    }

    // Check if user's role is allowed
    if (!allowedRoles.includes(req.user.role)) {

      return next(
        new ApiError(
          403,
          "You do not have permission to perform this action"
        )
      );

    }

    // Role allowed
    next();

  };

};

export { authorizeRoles };