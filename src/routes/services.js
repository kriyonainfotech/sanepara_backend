import { Router } from 'express';
import { Service } from '../models/Service.js';
import { CustomerService } from '../models/CustomerService.js';
import { syncServiceTasks } from '../services/scheduleSync.js';
import { protect, can, hasPermission } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../utils/asyncHandler.js';

const router = Router();
router.use(protect);

const isId = (v) => /^[a-f\d]{24}$/i.test(String(v || ''));

const clean = (body) => ({
  name: body.name,
  description: body.description,
  price: body.price,
  isActive: body.isActive,
  tasks: Array.isArray(body.tasks)
    ? body.tasks
        .map((t) => ({ ...(isId(t?._id) && { _id: t._id }), title: (t?.title ?? t).toString().trim() }))
        .filter((t) => t.title)
    : undefined,
});
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// Listing is also needed by whoever can assign services to customers.
const canList = (req, _res, next) =>
  hasPermission(req, 'services', 'view') || hasPermission(req, 'services', 'assign')
    ? next()
    : next(new HttpError(403, 'You do not have access to this'));

router.get(
  '/',
  canList,
  asyncHandler(async (req, res) => {
    const { q, status, customers, sort } = req.query;
    const filter = {};
    if (req.query.active === 'true' || status === 'active') filter.isActive = true;
    else if (status === 'inactive') filter.isActive = false;
    if (q?.trim()) {
      const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { description: rx }, { 'tasks.title': rx }];
    }
    const found = await Service.find(filter).collation({ locale: 'en', numericOrdering: true }).sort({ name: 1 }).lean();
    const counts = await CustomerService.aggregate([{ $group: { _id: '$service', n: { $sum: 1 } } }]);
    const byId = Object.fromEntries(counts.map((c) => [c._id.toString(), c.n]));
    let services = found.map((s) => ({ ...s, customerCount: byId[s._id] || 0 }));
    // Services are few, so the customer filter, sort and paging happen in memory.
    if (customers === 'assigned') services = services.filter((s) => s.customerCount > 0);
    else if (customers === 'none') services = services.filter((s) => s.customerCount === 0);
    const sorters = {
      newest: (a, b) => b.createdAt - a.createdAt,
      price_high: (a, b) => b.price - a.price,
      price_low: (a, b) => a.price - b.price,
      customers: (a, b) => b.customerCount - a.customerCount,
    };
    if (sorters[sort]) services.sort(sorters[sort]);

    // Without ?page the full list is returned (pickers on other pages need it).
    if (!req.query.page) return res.json({ services });
    const limit = Math.min(100, parseInt(req.query.limit) || 12);
    const total = services.length;
    const pages = Math.ceil(total / limit) || 1;
    const page = Math.min(pages, Math.max(1, parseInt(req.query.page) || 1));
    res.json({ services: services.slice((page - 1) * limit, page * limit), total, page, pages });
  })
);

router.post(
  '/',
  can('services', 'create'),
  asyncHandler(async (req, res) => {
    if (await Service.exists({ name: req.body.name?.trim() }))
      throw new HttpError(400, 'A service with this name already exists');
    const service = await Service.create(strip(clean(req.body)));
    res.status(201).json({ service });
  })
);

router.put(
  '/:id',
  can('services', 'edit'),
  asyncHandler(async (req, res) => {
    const before = await Service.findById(req.params.id).lean();
    if (!before) throw new HttpError(404, 'Service not found');
    const data = strip(clean(req.body));
    if (data.tasks) {
      // Keep each task's id: by the id the form sent, else by an unchanged title,
      // so customers' items stay linked to it.
      const known = new Set(before.tasks.map((t) => String(t._id)));
      const free = before.tasks.filter((t) => !data.tasks.some((n) => String(n._id) === String(t._id)));
      data.tasks = data.tasks.map((t) => {
        if (t._id && known.has(String(t._id))) return t;
        const same = free.findIndex((o) => o.title === t.title);
        return same >= 0 ? { _id: free.splice(same, 1)[0]._id, title: t.title } : { title: t.title };
      });
    }
    const service = await Service.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true });
    // Customers who already have this service get the added / renamed / removed tasks too.
    if (data.tasks) await syncServiceTasks(before.tasks, service, req.user._id);
    res.json({ service });
  })
);

router.delete(
  '/:id',
  can('services', 'delete'),
  asyncHandler(async (req, res) => {
    if (await CustomerService.exists({ service: req.params.id }))
      throw new HttpError(400, 'This service is assigned to customers. Mark it inactive instead.');
    const service = await Service.findByIdAndDelete(req.params.id);
    if (!service) throw new HttpError(404, 'Service not found');
    res.json({ message: 'Service deleted' });
  })
);

export default router;
