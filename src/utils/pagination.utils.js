const getPagination = (
  page = 1,
  limit = 10
) => {

  const skip = (page - 1) * limit;

  return {
    page: Number(page),
    limit: Number(limit),
    skip
  };
};

export { getPagination };