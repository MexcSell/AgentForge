// Client mirror of server/services/access.js, to hide what the server would refuse anyway (it is the authority).
export const isAdmin = (u) => u?.role === 'admin' && u.status === 'active';
export const can = (u, perm) => !!u && u.status === 'active' && (isAdmin(u) || u.permissions?.[perm] === true);

// Views that need more than a signed-in account: a capability flag, or 'admin'.
const VIEW_ACCESS = { agents: 'manageAgents', files: 'admin', models: 'manageSettings', github: 'admin', settings: 'manageSettings', users: 'admin' };
export const canView = (u, view) => {
  const need = VIEW_ACCESS[view];
  return !need || (need === 'admin' ? isAdmin(u) : can(u, need));
};
