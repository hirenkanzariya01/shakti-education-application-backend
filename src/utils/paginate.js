const { z } = require('zod');

// ?page=1&limit=20 (limit capped). Used by every list endpoint added for the video/review/placement features.
const pageQuery = (defaultLimit = 20, maxLimit = 50) =>
  z.object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  });

const pageResult = (items, total, { page, limit }) => ({ items, page, limit, total, hasMore: page * limit < total });

module.exports = { pageQuery, pageResult };
