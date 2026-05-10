import jwt from "jsonwebtoken";
import { ApiError } from "../utils/ApiError";
import { asyncHandler } from "../utils/asyncHandler";
import { User} from "../models/user.model";

const verifyToken = async (req, res, next) => {
try {    
    const token = req.cookies?.token|| req.header("Authorization")?.replace("Bearer ", "");
    if (!token) {
        throw new ApiError(401, "No token provided");
    }
    const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
   user= await User.findById(decodedToken.id).select("-password -refreshToken");
    

    if (!user) {
        throw new ApiError(401,"user not found create your account first")


}
req.user = user;
next();
}catch (error) {
    next(
        new ApiError(401, error.message||"Invalid token", [], error.stack)
    )
}

}
export {verifyToken}