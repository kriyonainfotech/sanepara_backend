export const STATUSES = ['Pending', 'Done', 'Overdue'];

const DONE = ['done', 'completed', 'approved', 'posted'];
export const isDoneStatus = (s) => DONE.includes(String(s || '').trim().toLowerCase());
