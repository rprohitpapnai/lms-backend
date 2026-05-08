const getMonthRange = (year, month) => {

  // First day of month
  const start = new Date(year, month, 1);

  // First day of next month
  const end = new Date(year, month + 1, 1);

  return { start, end };
};

export { getMonthRange };