const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

const courseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    icon: { type: String, default: 'book-outline' },
    // One of the covers bundled in the app (e.g. 'graphic-design'); imageUrl overrides it when set.
    imageKey: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    shortDescription: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 4000 },
    duration: { type: String, required: true, trim: true, maxlength: 40 },
    level: { type: String, enum: ['Beginner', 'Intermediate', 'Advanced'], default: 'Beginner' },
    fee: { type: Number, required: true, min: 0 },
    instructor: { type: String, required: true, trim: true, maxlength: 80 },
    rating: { type: Number, min: 0, max: 5, default: 0 },
    studentsEnrolled: { type: Number, min: 0, default: 0 },
    syllabus: { type: [String], default: [] },
    published: { type: Boolean, default: true, index: true },
    // The Google Drive folder this course's videos are imported from (set by the admin's "Import from Drive").
    driveFolderId: { type: String, default: '', trim: true, maxlength: 100 },
  },
  { timestamps: true }
);
courseSchema.plugin(jsonPlugin);

module.exports = mongoose.model('Course', courseSchema);
