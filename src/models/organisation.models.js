import mongoose, {Schema } from "mongoose";

const organisationSchema = new Schema ({
 owner:{
     type:mongoose.Schema.Types.ObjectId,
     ref:"User",
     required:true
 },
 name:{
     type:String,
     required:true
 },
 plan :{
    type:String,
    enum:["free","premium","enterprise","custom"],
    required:true,
    default:"free"
 },
 planStartDate:{
    type:Date,
    required:true
 },
 planEndDate:{
     type:Date,
     required:true
 },
 planStatus:{
    type:Boolean,
    required:true
 },

 admins:[
    {
        type: mongoose.Schema.Types.ObjectId,
        ref:"User"
    }
 ],
 


 
 

}, { timestamps:true })


export const Organisation = mongoose.model("Organisation", organisationSchema)