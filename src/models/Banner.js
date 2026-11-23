const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

const bannerSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },
    subtitle: { type: String, trim: true, maxlength: 140, default: '' },
    cta: { type: String, trim: true, maxlength: 30, default: 'Learn more' },
    // Where the button leads inside the app: Courses | LiveClasses | Placement | MyLearning
    target: { type: String, enum: ['Courses', 'LiveClasses', 'Placement', 'MyLearning'], default: 'Courses' },
    icon: { type: String, default: 'sparkles-outline' },
    imageKey: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
bannerSchema.plugin(jsonPlugin);

module.exports = mongoose.model('Banner', bannerSchema);
