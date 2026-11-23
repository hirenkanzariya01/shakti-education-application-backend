const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 15, default: '' },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['student', 'admin'], default: 'student', index: true },
    city: { type: String, trim: true, maxlength: 80, default: '' },
    dob: { type: String, default: '' }, // YYYY-MM-DD, optional
    avatarUrl: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    lastLesson: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson', default: null },
    // Bumping this invalidates every token issued before (password change, "log out everywhere").
    tokenVersion: { type: Number, default: 0 },
    resetTokenHash: { type: String, default: null },
    resetTokenExpires: { type: Date, default: null },
  },
  { timestamps: true }
);
userSchema.plugin(jsonPlugin);

// Any change to a user must be visible to the very next request, so drop the auth cache entry.
const userCache = require('../utils/userCache');
userSchema.post('save', (doc) => userCache.drop(doc._id));
userSchema.post('findOneAndUpdate', (doc) => doc && userCache.drop(doc._id));
userSchema.post('findOneAndDelete', (doc) => doc && userCache.drop(doc._id));
userSchema.post('deleteOne', { document: true, query: false }, (doc) => userCache.drop(doc._id));
userSchema.post('updateOne', function () { userCache.clear(); });
userSchema.post('updateMany', function () { userCache.clear(); });
userSchema.post('deleteMany', function () { userCache.clear(); });

module.exports = mongoose.model('User', userSchema);
