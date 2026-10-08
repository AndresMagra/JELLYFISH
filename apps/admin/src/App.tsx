import type { AdminSummaryDTO } from '@jellyfish/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Banknote,
  Boxes,
  ClipboardList,
  FileSpreadsheet,
  LayoutDashboard,
  LogOut,
  MapPin,
  ScrollText,
  ShoppingBasket,
  TicketPercent,
  Users,
  Wallet,
} from 'lucide-react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Button } from './components/ui';
import { api } from './lib/api';
import { Audit } from './pages/Audit';
import { Catalog } from './pages/Catalog';
import { Coupons } from './pages/Coupons';
import { Dashboard } from './pages/Dashboard';
import { Inventory } from './pages/Inventory';
import { OrderDetail } from './pages/OrderDetail';
import { Orders } from './pages/Orders';
import { Payments } from './pages/Payments';
import { PriceList } from './pages/PriceList';
import { Team } from './pages/Team';
import { Zones } from './pages/Zones';

export const useSummary = () =>
  useQuery({
    queryKey: ['admin', 'summary'],
    queryFn: () => api<AdminSummaryDTO>('/v1/admin/summary'),
    refetchInterval: 15_000,
  });

function Sidebar() {
  const { user, isAdmin, signOut } = useAuth();
  const { data } = useSummary();
  const toPick = (data?.active.confirmed ?? 0) + (data?.active.picking ?? 0);
  const money = (data?.refunds.count ?? 0) + (data?.transfersToVerify ?? 0);
  const link = (to: string, icon: React.ReactNode, label: string, count?: number) => (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
      {icon}
      {label}
      {count ? <span className="count">{count}</span> : null}
    </NavLink>
  );
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="bell" />
        JELLYFISH
      </div>
      <nav className="nav stack" style={{ gap: 4 }}>
        {link('/', <LayoutDashboard size={18} />, 'Resumen')}
        {link('/pedidos', <ClipboardList size={18} />, 'Pedidos', toPick)}
        {link(
          '/catalogo',
          <ShoppingBasket size={18} />,
          'Catálogo y precios',
          data?.catalog.blocked,
        )}
        {isAdmin
          ? link('/lista-de-precios', <FileSpreadsheet size={18} />, 'Lista de precios')
          : null}
        {link('/inventario', <Boxes size={18} />, 'Inventario')}
        {link('/pagos', <Wallet size={18} />, 'Pagos y caja', money)}
        {link('/cupones', <TicketPercent size={18} />, 'Cupones')}
        {isAdmin ? link('/zonas', <MapPin size={18} />, 'Zonas de entrega') : null}
        {isAdmin ? link('/equipo', <Users size={18} />, 'Equipo') : null}
        {isAdmin ? link('/bitacora', <ScrollText size={18} />, 'Bitácora') : null}
      </nav>
      <div className="grow" />
      <div className="muted small" style={{ padding: '0 10px' }}>
        <Banknote size={14} style={{ verticalAlign: -2 }} /> {user.name || user.phone}
        <br />
        {user.role === 'admin' ? 'Administrador' : 'Personal'}
      </div>
      <Button variant="ghost" small onClick={signOut}>
        <LogOut size={15} /> Cerrar sesión
      </Button>
    </aside>
  );
}

export function App() {
  const { isAdmin } = useAuth();
  const { data } = useSummary();
  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        {data && data.catalog.blocked > 0 && data.catalog.blocked === data.catalog.variants ? (
          <div className="banner warn" style={{ marginBottom: 16 }}>
            Ningún producto está publicado todavía: confirma precios e ITBIS en{' '}
            <Link to="/catalogo">Catálogo y precios</Link> o importa tu inventario.
          </div>
        ) : null}
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/pedidos" element={<Orders />} />
          <Route path="/pedidos/:id" element={<OrderDetail />} />
          <Route path="/catalogo" element={<Catalog />} />
          <Route
            path="/lista-de-precios"
            element={isAdmin ? <PriceList /> : <Navigate to="/" replace />}
          />
          <Route path="/inventario" element={<Inventory />} />
          <Route path="/pagos" element={<Payments />} />
          <Route path="/cupones" element={<Coupons />} />
          <Route path="/zonas" element={isAdmin ? <Zones /> : <Navigate to="/" replace />} />
          <Route path="/equipo" element={isAdmin ? <Team /> : <Navigate to="/" replace />} />
          <Route path="/bitacora" element={isAdmin ? <Audit /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
