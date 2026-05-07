class ApiError extends Error {
constructor (statuscode,message="something went wrong but no message was provided this is the default message", errors=[], stack=""){
    super(message);
    this.statuscode = statuscode;
    this.message = message;
    this.errors = errors;
    this.stack = stack;
    this.success = false;

    if(stack){
        this.stack = stack;
    }
    else{
        Error.captureStackTrace(this, this.constructor);
    }

}
}

export default {ApiError} ;
