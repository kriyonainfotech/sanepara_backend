import { Sale } from '../models/Sale.js';
import { SalePayment } from '../models/SalePayment.js';

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
