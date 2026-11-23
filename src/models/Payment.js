const mongoose = require('mongoose');
const jsonPlugin = require('./plugin');

// A fee instalment. Staff record payments received at the institute (cash, bank transfer, UPI...).
// No online payment gateway is integrated.
const paymentSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    amount: { type: Number, required: true, min: 1 },
    dueDate: { type: Date, required: true },
    status: { type: String, enum: ['Pending', 'Paid'], default: 'Pending', index: true },
    paidAt: { type: Date, default: null },
    method: { type: String, trim: true, maxlength: 40, default: null },
    receiptNo: { type: String, trim: true, sparse: true, unique: true },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);
paymentSchema.plugin(jsonPlugin);

module.exports = mongoose.model('Payment', paymentSchema);
