import mongoose, {Schema } from "mongoose";

const paymentSchema = new Schema ({
studentId:{
    type:mongoose.Schema.Types.ObjectId,
    ref:"User",
    required:true
},
enrollmentId:{
    type:mongoose.Schema.Types.ObjectId,
    ref:"Enrollment",
    required:true
},
amount:{
    type:Number,
    required:true
},
currency:{
    type:String,
    default:"USD"
},
status:{
    type:String,
    enum:["pending","active","completed","cancelled"],
    required:true,
    default:"pending"
},
transactionId:{
    type:String,
    required:true
},
paymentDate:{
    type:Date,
    default:Date.now
}

},{ timestamps:true })

paymentSchema.index({ studentId: 1 });
paymentSchema.index({ enrollmentId: 1 });



export const Payment = mongoose.model("Payment", paymentSchema)

