import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import { SupportQuery } from '../models/SupportQuery.js';
import { Service } from '../models/Service.js';
import { Task } from '../models/Task.js';
import { User } from '../models/User.js';
import { protect, superAdminOnly } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';

const router = Router();
const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const categories = ['Complaint', 'Application Status', 'Document Request', 'Correction / Changes', 'Payment / Billing Query', 'Other'];
const cleanAnswers = (items) => Array.isArray(items) ? items.slice(0, 50).map((item) => ({
  question: clean(item?.question, 300), answer: clean(item?.answer, 3000),
})).filter((item) => item.question && item.answer) : [];

async function saveResponse(responseId, fields) {
  const ownerEmail = process.env.SUPPORT_OWNER_EMAIL?.trim().toLowerCase();
  const owner = await User.findOne({ role: 'superadmin', isActive: true, deletedAt: null, ...(ownerEmail && { email: ownerEmail }) })
    .sort({ createdAt: 1, _id: 1 }).select('_id');
  if (!owner) throw new HttpError(503, 'Support query owner is not configured');
  try {
    await SupportQuery.updateOne({ responseId }, { $setOnInsert: { owner: owner._id, ...fields } }, { upsert: true, timestamps: false });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
}

router.get('/services', asyncHandler(async (_req, res) => {
  const services = await Service.find({ isActive: true }).select('name').sort({ name: 1 }).lean();
  res.json({ services });
}));

router.post('/submit', asyncHandler(async (req, res) => {
  const { submissionId, category, serviceId, website } = req.body;
  if (website) return res.status(201).json({ received: true });
  const name = clean(req.body.name, 100);
  const mobile = typeof req.body.mobile === 'string' ? req.body.mobile.trim() : '';
  const details = clean(req.body.details, 3000);
  const reference = clean(req.body.reference, 100);
  if (typeof submissionId !== 'string' || !/^[a-f\d-]{36}$/i.test(submissionId) || !name || !/^\d{10}$/.test(mobile) || !details || !categories.includes(category)) {
    throw new HttpError(400, 'Enter your name, 10-digit mobile number, request type and details');
  }
  const service = mongoose.isValidObjectId(serviceId) ? await Service.findOne({ _id: serviceId, isActive: true }).select('name').lean() : null;
  if (!service) throw new HttpError(400, 'Select an available service');
  await saveResponse(`web:${submissionId}`, {
    category,
    submittedAt: new Date(),
    answers: [
      { question: 'Name', answer: name },
      { question: 'Mobile / WhatsApp number', answer: mobile },
      { question: 'Service Type', answer: service.name },
      ...(reference ? [{ question: 'Application / reference number', answer: reference }] : []),
      { question: 'Request details', answer: details },
    ],
  });
  res.status(201).json({ received: true });
}));

router.post('/intake', asyncHandler(async (req, res) => {
  const secret = process.env.SUPPORT_FORM_SECRET;
  if (!secret) throw new HttpError(503, 'Support form intake is not configured');
  const expected = Buffer.from(secret);
  const provided = Buffer.from(req.get('X-Support-Form-Secret') || '');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new HttpError(401, 'Invalid form credentials');

  const { responseId: rawId, answers: rawAnswers, submittedAt, email } = req.body;
  const responseId = clean(rawId, 300);
  const answers = cleanAnswers(rawAnswers);
  const date = new Date(submittedAt);
  if (!responseId || !answers.length || !submittedAt || !Number.isFinite(+date)) throw new HttpError(400, 'Invalid form response');
  const category = categories.includes(req.body.category) ? req.body.category : 'Other';
  await saveResponse(responseId, { category, answers, email: clean(email, 300), submittedAt: date });
  res.status(200).json({ received: true });
}));

router.use(protect, superAdminOnly);

router.get('/new', asyncHandler(async (req, res) => {
  const [unassigned] = await SupportQuery.aggregate([
    { $match: { owner: req.user._id } },
    { $lookup: { from: Task.collection.name, localField: '_id', foreignField: 'supportQuery', as: 'task' } },
    { $match: { 'task.0': { $exists: false } } },
    { $limit: 1 },
    { $project: { _id: 1 } },
  ]);
  res.json({ hasNew: Boolean(unassigned) });
}));

router.get('/', asyncHandler(async (req, res) => {
  const page = Number(req.query.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new HttpError(400, 'Invalid page');
  const pageSize = 25;
  const { category, status } = req.query;
  if (category && !categories.includes(category)) throw new HttpError(400, 'Invalid request type');
  const search = clean(req.query.search, 150);
  const rx = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  const done = /^(done|completed|approved|posted)$/i;
  const statusFilters = {
    new: { task: { $exists: false } },
    assigned: { 'task.status': { $exists: true, $not: done } },
    done: { 'task.status': done },
  };
  const [result] = await SupportQuery.aggregate([
    { $match: { owner: req.user._id, ...(category && { category }) } },
    { $lookup: {
      from: Task.collection.name, localField: '_id', foreignField: 'supportQuery', as: 'task',
      pipeline: [{ $project: { status: 1, assignedTo: 1, dueDate: 1, supportService: 1 } }],
    } },
    { $unwind: { path: '$task', preserveNullAndEmptyArrays: true } },
    ...(Object.hasOwn(statusFilters, status) ? [{ $match: statusFilters[status] }] : []),
    ...(rx ? [{ $match: { $or: [{ category: rx }, { email: rx }, { 'answers.answer': rx }, { 'task.supportService': rx }] } }] : []),
    { $facet: {
      data: [{ $sort: { submittedAt: -1, _id: -1 } }, { $skip: (page - 1) * pageSize }, { $limit: pageSize }],
      total: [{ $count: 'count' }],
    } },
  ]);
  const data = result?.data || [];
  await Task.populate(data.map((query) => query.task).filter(Boolean), { path: 'assignedTo', select: 'name' });
  const total = result?.total[0]?.count || 0;
  res.json({ data, pages: Math.max(1, Math.ceil(total / pageSize)), total });
}));

router.post('/:id/assign', asyncHandler(async (req, res) => {
  const { assignedTo, dueDate } = req.body;
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Support query not found');
  if (!isDayKey(dueDate) || dueDate < todayKey()) throw new HttpError(400, 'Pick a due date from today onwards');
  if (!mongoose.isValidObjectId(assignedTo) || !await User.exists({ _id: assignedTo, role: 'team', isActive: true, deletedAt: null })) {
    throw new HttpError(400, 'Select an active team member');
  }
  const query = await SupportQuery.findOne({ _id: req.params.id, owner: req.user._id }).lean();
  if (!query) throw new HttpError(404, 'Support query not found');
  const title = clean(req.body.title, 200);
  if (!title) throw new HttpError(400, 'Enter the task title');
  const description = clean(req.body.instruction, 2000);
  const serviceId = req.body.serviceId;
  const service = mongoose.isValidObjectId(serviceId) ? await Service.findOne({ _id: serviceId, isActive: true }).select('name').lean() : null;
  if (serviceId && !service) throw new HttpError(400, 'Select an available service');
  const supportService = service?.name || query.answers.find(({ question }) => question === 'Service Type')?.answer;
  try {
    const task = await Task.create({ supportQuery: query._id, supportService, title, description, assignedTo, dueDate, type: 'Team', taskCategory: 'Support', createdBy: req.user._id });
    res.status(201).json({ id: task._id });
  } catch (error) {
    if (error.code === 11000) throw new HttpError(409, 'This query already has a task');
    throw error;
  }
}));

router.put('/:id', asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Support query not found');
  const { category, email } = req.body;
  const answers = cleanAnswers(req.body.answers);
  if (!categories.includes(category) || !answers.length) throw new HttpError(400, 'Select a request type and enter the query details');
  const query = await SupportQuery.findOneAndUpdate(
    { _id: req.params.id, owner: req.user._id },
    { category, answers, email: clean(email, 300) },
    { new: true, runValidators: true },
  );
  if (!query) throw new HttpError(404, 'Support query not found');
  res.json({ message: 'Support query updated' });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'Support query not found');
  const query = await SupportQuery.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
  if (!query) throw new HttpError(404, 'Support query not found');
  res.json({ message: 'Support query deleted' });
}));

export default router;
