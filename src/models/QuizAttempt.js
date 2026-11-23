const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

const quizAttemptSchema = new mongoose.Schema(
  {
    quiz: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', required: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    answers: [{ _id: false, question: { type: mongoose.Schema.Types.ObjectId, required: true }, selected: { type: Number, required: true, min: 0, max: 5 } }],
    submittedAt: { type: Date, default: Date.now },
    // Filled in only when the teacher declares the result.
    score: { type: Number, default: null },
    totalMarks: { type: Number, default: null },
    correctCount: { type: Number, default: null },
  },
  { timestamps: true }
);
quizAttemptSchema.index({ quiz: 1, student: 1 }, { unique: true }); // one attempt per student
quizAttemptSchema.plugin(jsonPlugin);
module.exports = mongoose.model('QuizAttempt', quizAttemptSchema);
