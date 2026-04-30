import mongoose, {Schema } from "mongoose";
const enrollmentSchema = new Schema ({},{ timestamps:true })


export const Enrollment = mongoose.model("Enrollment", enrollmentSchema)