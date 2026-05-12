const errorHandler = (
  err,
  req,
  res,
  next
) => {

  // Get status code
  const statusCode = err.statusCode || 500;

  // Get message
  const message =
    err.message || "Internal Server Error";

  // Send response to frontend
  res.status(statusCode).json({

    success: false,

    message: message,

    errors: err.errors || [],

    stack:
      process.env.NODE_ENV === "development"
        ? err.stack
        : undefined

  });

};

export { errorHandler };