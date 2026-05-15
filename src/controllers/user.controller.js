import jwt from "jsonwebtoken";
import { User } from "../models/user.models.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { verifyJWT } from "../middlewares/jwt.middleware.js";
import { verifyOrganization } from "../middlewares/organisation.middleware.js";



const 