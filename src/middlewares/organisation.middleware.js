import { ApiError } from "../utils/ApiError.js";

const verifyOrganization = (
  req,
  res,
  next
) => {

  // User must exist
  if (!req.user) {

    return next(
      new ApiError(401, "Unauthorized request")
    );

  }

  // User must belong to organization
  if (!req.user.organizationId) {

    return next(
      new ApiError(
        403,
        "Organization access denied"
      )
    );

  }

  next();

};

export { verifyOrganization };