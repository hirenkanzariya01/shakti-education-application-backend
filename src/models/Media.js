const mongoose = require('mongoose');

// Small images (profile photos, company logos) stored in MongoDB so no extra storage service is needed.
// The admin panel shrinks images before upload; the API enforces a hard size cap. Not for videos.
const mediaSchema = new mongoose.Schema(
  {
    data: { type: Buffer, required: true },
    contentType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'], required: true },
    size: { type: Number, required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Media', mediaSchema);
