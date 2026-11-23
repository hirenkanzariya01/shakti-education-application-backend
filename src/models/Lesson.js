const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

const lessonSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    order: { type: Number, required: true, min: 1 },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    duration: { type: String, trim: true, maxlength: 20, default: '' },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    // Optional grouping inside the course.
    module: { type: mongoose.Schema.Types.ObjectId, ref: 'Module', default: null },
    // Older lessons only have a plain link. Newer ones use `video` (provider-based, see services/providers).
    videoUrl: { type: String, trim: true, maxlength: 500, default: '' },
    video: {
      provider: { type: String, trim: true, maxlength: 40, default: '' }, // 'google-drive' | 'link' | future providers
      ref: { type: String, trim: true, maxlength: 500, default: '' }, // Drive file ID, or a URL for 'link'
      mimeType: { type: String, trim: true, maxlength: 80, default: '' },
      durationSeconds: { type: Number, min: 0, default: 0 },
      sizeBytes: { type: Number, min: 0, default: 0 },
      hasThumbnail: { type: Boolean, default: false }, // provider can supply one
      thumbnailUrl: { type: String, trim: true, maxlength: 500, default: '' }, // admin-chosen image (overrides provider)
    },
    published: { type: Boolean, default: true },
  },
  { timestamps: true }
);
lessonSchema.index({ course: 1, order: 1 });
lessonSchema.plugin(jsonPlugin);

module.exports = mongoose.model('Lesson', lessonSchema);
