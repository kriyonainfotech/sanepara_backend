import mongoose from 'mongoose';
import { Sale } from '../models/Sale.js';
import { SalePayment } from '../models/SalePayment.js';
import { Customer } from '../models/Customer.js';
import { CustomerService } from '../models/CustomerService.js';
import { B2BPartner } from '../models/B2BPartner.js';
import { User } from '../models/User.js';
import { HttpError } from '../utils/asyncHandler.js';
import { isDayKey, todayKey } from '../utils/dates.js';

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const computeFees = (professionalFee, govtFee) => {
  const p = money(professionalFee), g = money(govtFee);
  return { professionalFee: p, govtFee: g, totalAmount: money(p + g) };
};

export const commissionOf = (sale) => money((sale.professionalFee * (sale.b2bPartner ? sale.b2bPercent || 0 : 0)) / 100);

// Re-split every payment (govt fee first) and refresh the sale's totals/status.
export async function recalcSale(saleOrId) {
  const sale = typeof saleOrId === 'object' ? saleOrId : await Sale.findById(saleOrId);
  if (!sale) return null;
  const payments = await SalePayment.find({ sale: sale._id }).sort({ date: 1, createdAt: 1 });

  let govtLeft = sale.govtFee;
  let received = 0, discount = 0, govtReceived = 0;
  for (const p of payments) {
    const g = money(Math.min(p.amount, Math.max(0, govtLeft)));
    const pro = money(p.amount - g);
    govtLeft -= g;
    received += p.amount;
    discount += p.discount;
    govtReceived += g;
    if (p.govtPart !== g || p.professionalPart !== pro) {
      p.govtPart = g;
      p.professionalPart = pro;
      await p.save();
    }
  }
  sale.receivedAmount = money(received);
  sale.discountAmount = money(discount);
  sale.govtReceived = money(govtReceived);
  sale.balance = money(sale.totalAmount - received - discount);
  sale.status = sale.balance <= 0 ? (received > 0 ? 'Cleared' : 'Written Off') : received > 0 ? 'Partial' : 'Pending';
  sale.b2bCommission = commissionOf(sale);
  await sale.save();
  return sale;
}

// Validated sale fields from a request body (`existing` when editing).
export async function buildSale(body, existing) {
  const data = {};
  const customerId = body.customer ?? existing?.customer;
  if (!mongoose.isValidObjectId(customerId) || !(await Customer.exists({ _id: customerId }))) throw new HttpError(400, 'Select a customer');
  data.customer = customerId;

  if (body.customerService !== undefined) {
    if (body.customerService) {
      const cs = await CustomerService.findById(body.customerService);
      if (!cs || String(cs.customer) !== String(customerId)) throw new HttpError(400, 'That service is not assigned to this customer');
      data.customerService = cs._id;
      data.service = cs.service;
    } else {
      data.customerService = undefined;
      data.service = mongoose.isValidObjectId(body.service) ? body.service : undefined;
    }
  } else if (body.service !== undefined) {
    data.service = mongoose.isValidObjectId(body.service) ? body.service : undefined;
  }

  const title = (body.title ?? existing?.title)?.trim();
  if (!title) throw new HttpError(400, 'Add what the sale is for');
  data.title = title;

  const fees = computeFees(body.professionalFee ?? existing?.professionalFee, body.govtFee ?? existing?.govtFee);
  if (fees.totalAmount <= 0) throw new HttpError(400, 'Enter the professional fee and/or government fee');
  if (existing && fees.totalAmount < existing.receivedAmount + existing.discountAmount)
    throw new HttpError(400, `Total cannot be less than what is already received (₹${existing.receivedAmount + existing.discountAmount})`);
  Object.assign(data, fees);

  const saleDate = body.saleDate ?? existing?.saleDate ?? todayKey();
  if (!isDayKey(saleDate)) throw new HttpError(400, 'Pick the sale date');
  data.saleDate = saleDate;

  if (body.soldBy !== undefined) {
    if (body.soldBy && !(mongoose.isValidObjectId(body.soldBy) && (await User.exists({ _id: body.soldBy })))) throw new HttpError(400, 'Select a valid member');
    data.soldBy = body.soldBy || undefined;
  }

  if (body.b2bPartner !== undefined) {
    if (body.b2bPartner) {
      const partner = await B2BPartner.findById(body.b2bPartner);
      if (!partner) throw new HttpError(400, 'Select a valid B2B partner');
      data.b2bPartner = partner._id;
      const pct = body.b2bPercent === undefined || body.b2bPercent === '' ? partner.percentage : Number(body.b2bPercent);
      if (!(pct >= 0 && pct <= 100)) throw new HttpError(400, 'Partner % must be between 0 and 100');
      data.b2bPercent = pct;
    } else {
      data.b2bPartner = undefined;
      data.b2bPercent = 0;
    }
  } else if (body.b2bPercent !== undefined && existing?.b2bPartner) {
    data.b2bPercent = Number(body.b2bPercent) || 0;
  }
  // A person (not a B2B partner) who referred the work, and what they get for it.
  if (body.referredBy !== undefined) data.referredBy = String(body.referredBy || '').trim();
  if (body.referralAmount !== undefined) {
    const amt = money(body.referralAmount);
    if (amt < 0) throw new HttpError(400, 'Referral amount cannot be negative');
    data.referralAmount = amt;
  }
  if (body.notes !== undefined) data.notes = body.notes;
  return data;
}
