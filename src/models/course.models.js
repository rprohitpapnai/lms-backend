import mongoose, {Schema } from "mongoose";

const courseSchema = new Schema ({},{ timestamps:true })


export const Course = mongoose.model("Course", courseSchema)