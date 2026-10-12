// Prices, matching the enquiry form in index.html. Change both together.

import { dayNum, isoDay } from './planner.js';

export const SINGLE = 16;
export const SHARED = 25;
export const DEPOSIT = 30;
const DOUBLE = ['12-25', '12-26', '01-01'];

// A kennel holds 1 or 2 cats, so k kennels for n cats means n - k shared and 2k - n single

export function nightly(cats, kennels) {
  const k = Math.min(cats, Math.max(kennels, Math.ceil(cats / 2)));
  return (cats - k) * SHARED + (2 * k - cats) * SINGLE;
}

// Nights over Christmas Day, Boxing Day and New Year's Day cost double

export function standardBill(b) {
  const a = dayNum(b.arrive);
  const nights = dayNum(b.depart) - a;
  let doubles = 0;
  for (let n = a; n < a + nights; n++) if (DOUBLE.includes(isoDay(n).slice(5))) doubles++;
  return { nights, doubles, rate: nightly(+b.cats, +b.kennels), total: (nights + doubles) * nightly(+b.cats, +b.kennels) };
}

const hasCustom = b => b.bill !== null && b.bill !== undefined && b.bill !== '';
export const billTotal = b => (hasCustom(b) ? +b.bill : standardBill(b).total);
export const depositAmount = b => DEPOSIT * +b.cats;
export const owed = b => (b.bill_paid ? 0 : Math.max(0, billTotal(b) - (b.deposit_paid ? depositAmount(b) : 0)));
export const isCustomBill = hasCustom;
export const gbp = n => '£' + (Math.round(n * 100) / 100).toLocaleString('en-GB', { minimumFractionDigits: n % 1 ? 2 : 0 });
