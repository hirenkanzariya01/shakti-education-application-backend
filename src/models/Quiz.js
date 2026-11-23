const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

const questionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 500 },
    options: { type: [{ type: String, trim: true, maxlength: 200 }], validate: (v) => v.length >= 2 && v.length <= 6 },
    correctIndex: { type: Number, required: true, min: 0, max: 5 }, // NEVER sent to students before the teacher reveals answers
    marks: { type: Number, default: 1, min: 1, max: 100 },
  },
  { timestamps: false }
);

const quizSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', trim: true, maxlength: 600 },
    questions: { type: [questionSchema], default: [] },
    // draft: hidden from students. published: students can answer. closed: no more answers.
    status: { type: String, enum: ['draft', 'published', 'closed'], default: 'draft' },
    resultDeclared: { type: Boolean, default: false },
    resultDeclaredAt: { type: Date, default: null },
    revealAnswers: { type: Boolean, default: false }, // set by the teacher when declaring the result
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);
quizSchema.plugin(jsonPlugin);
module.exports = mongoose.model('Quiz', quizSchema);
