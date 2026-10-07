import {
  type BroadcastStatus,
  Button,
  type GeoFix,
  Icon,
  type LocationPermissionState,
  Text,
  openAppSettings,
  plainStorage,
  useLocationBroadcast,
  useSignedIn,
  useTheme,
} from '@jellyfish/mobile-core';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Pressable, View } from 'react-native';
import { sendDriverLocation, useDeliveries } from './api/hooks';
import { latestOutForDeliveryId } from './due';
import { Sheet, SheetPoint } from './Sheet';

/** Guarda que ya se le explicó al repartidor para qué sirve la ubicación (solo se explica una vez). */
const EXPLAINED_KEY = 'jellyfish.driver.locationExplained';

async function wasExplained(): Promise<boolean> {
  try {
    return (await plainStorage.getItem(EXPLAINED_KEY)) === '1';
  } catch {
    return false;
  }
}
async function markExplained(): Promise<void> {
  try {
    await plainStorage.setItem(EXPLAINED_KEY, '1');
  } catch {
    /* sin almacenamiento: se vuelve a explicar la próxima vez */
  }
}

interface Tracking {
  status: BroadcastStatus;
  permission: LocationPermissionState;
  /** Pedidos en camino (los que activan el envío de la ubicación). */
  outCount: number;
  lastSentAt: number | null;
  error: string | null;
  /**
   * Antes de "Salir a entregar": la primera vez explica para qué sirve la ubicación y pide el
   * permiso. Nunca bloquea: si dice "Ahora no" o lo niega, la entrega sigue igual.
   */
  askBeforeDeparture: () => Promise<void>;
  /** Desde el aviso de la lista: explica y pide el permiso, o abre Ajustes si ya no se puede preguntar. */
  enableFromNotice: () => Promise<void>;
}

const TrackingContext = createContext<Tracking | null>(null);

export function useTracking(): Tracking {
  const t = useContext(TrackingContext);
  if (!t) throw new Error('useTracking debe usarse dentro de <TrackingProvider>');
  return t;
}

/**
 * Manda la ubicación del repartidor mientras tenga al menos un pedido en camino (y la app esté
 * abierta), y ofrece a las pantallas el estado y las acciones de permiso. Va en el layout raíz.
 */
export function TrackingProvider({ children }: { children: ReactNode }) {
  const signedIn = useSignedIn();
  const deliveries = useDeliveries();
  const orders = useMemo(() => deliveries.data ?? [], [deliveries.data]);
  const outCount = orders.filter((o) => o.status === 'out_for_delivery').length;
  const orderId = latestOutForDeliveryId(orders);

  const orderIdRef = useRef(orderId);
  useEffect(() => {
    orderIdRef.current = orderId;
  }, [orderId]);
  const send = useCallback((fix: GeoFix) => sendDriverLocation(fix, orderIdRef.current), []);

  const broadcast = useLocationBroadcast({ enabled: signedIn && outCount > 0, send });
  const { recheckPermission, requestPermission } = broadcast;

  // ── Hoja que explica para qué se usa la ubicación ──
  const [explainerOpen, setExplainerOpen] = useState(false);
  const explainerDone = useRef<(() => void) | null>(null);
  const [asking, setAsking] = useState(false);

  /** Abre la hoja y espera a que la persona la cierre (con "Activar" o "Ahora no"). */
  const showExplainer = useCallback(
    () =>
      new Promise<void>((resolve) => {
        explainerDone.current = resolve;
        setExplainerOpen(true);
      }),
    [],
  );
  const closeExplainer = useCallback(() => {
    setExplainerOpen(false);
    explainerDone.current?.();
    explainerDone.current = null;
  }, []);

  const allow = useCallback(async () => {
    setAsking(true);
    try {
      await requestPermission();
    } finally {
      setAsking(false);
      closeExplainer();
    }
  }, [requestPermission, closeExplainer]);

  const askBeforeDeparture = useCallback(async () => {
    const state = await recheckPermission();
    if (state === 'granted' || state === 'blocked') return;
    if (await wasExplained()) return;
    await markExplained();
    await showExplainer();
  }, [recheckPermission, showExplainer]);

  const permissionRef = useRef(broadcast.permission);
  useEffect(() => {
    permissionRef.current = broadcast.permission;
  }, [broadcast.permission]);

  const enableFromNotice = useCallback(async () => {
    if (permissionRef.current === 'blocked') {
      openAppSettings();
      return;
    }
    await markExplained();
    await showExplainer();
  }, [showExplainer]);

  const value = useMemo<Tracking>(
    () => ({
      status: broadcast.status,
      permission: broadcast.permission,
      outCount,
      lastSentAt: broadcast.lastSentAt,
      error: broadcast.error,
      askBeforeDeparture,
      enableFromNotice,
    }),
    [
      broadcast.status,
      broadcast.permission,
      broadcast.lastSentAt,
      broadcast.error,
      outCount,
      askBeforeDeparture,
      enableFromNotice,
    ],
  );

  return (
    <TrackingContext.Provider value={value}>
      {children}
      <Sheet
        visible={explainerOpen}
        onClose={closeExplainer}
        label="Compartir tu ubicación"
        testID="location-sheet"
        dismissable={!asking}
      >
        <LocationExplainer asking={asking} onAllow={() => void allow()} onSkip={closeExplainer} />
      </Sheet>
    </TrackingContext.Provider>
  );
}

function LocationExplainer({
  asking,
  onAllow,
  onSkip,
}: {
  asking: boolean;
  onAllow: () => void;
  onSkip: () => void;
}) {
  const { colors } = useTheme();
  return (
    <>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: colors.surfaceAlt,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="map-marker-radius" size={28} color={colors.glow} />
      </View>
      <View style={{ gap: 6 }}>
        <Text variant="title">Deja que tus clientes vean tu avance</Text>
        <Text muted>
          Cuando salgas a entregar, cada cliente podrá ver en su app por dónde vas. Así nadie te
          llama para preguntar “¿ya casi llegas?”.
        </Text>
      </View>
      <View style={{ gap: 12 }}>
        <SheetPoint
          icon="cellphone"
          text="Solo funciona con la app abierta en pantalla. Si la cierras o pasas a otra app (como Waze), se pausa."
        />
        <SheetPoint
          icon="timer-sand"
          text="Se comparte únicamente mientras tengas pedidos en camino."
        />
        <SheetPoint icon="eye-off-outline" text="Al terminar la entrega, tu ubicación se borra." />
      </View>
      <Button
        title="Activar ubicación"
        icon="map-marker-check"
        loading={asking}
        onPress={onAllow}
        testID="location-allow"
      />
      <Button
        title="Ahora no"
        variant="ghost"
        disabled={asking}
        onPress={onSkip}
        testID="location-skip"
      />
    </>
  );
}

/**
 * Aviso discreto y permanente en la lista de entregas:
 *  - sin permiso: "Activa tu ubicación para que tus clientes vean tu avance" (con botón);
 *  - compartiendo: confirma que funciona y recuerda que es solo con la app abierta;
 *  - fuera de RD / GPS sin respuesta: lo dice sin bloquear nada.
 * No se muestra si no hay entregas.
 */
export function TrackingNotice({ hasDeliveries }: { hasDeliveries: boolean }) {
  const t = useTracking();
  const { colors, palette, radii } = useTheme();
  if (!hasDeliveries) return null;

  type Look = {
    id: string;
    icon: Parameters<typeof Icon>[0]['name'];
    tint: string;
    title: string;
    text: string;
    action?: string;
  };
  let look: Look | null = null;

  if (t.permission === 'blocked' || t.permission === 'denied' || t.permission === 'undetermined') {
    look = {
      id: 'location-notice',
      icon: 'map-marker-off-outline',
      tint: palette.warning,
      title: 'Activa tu ubicación para que tus clientes vean tu avance',
      text:
        t.permission === 'blocked'
          ? 'Está apagada para esta app: se activa en Ajustes del teléfono. Solo se comparte con la app abierta.'
          : 'Solo se comparte con la app abierta y mientras llevas pedidos en camino.',
      action: t.permission === 'blocked' ? 'Abrir ajustes' : 'Activar',
    };
  } else if (t.outCount > 0 && t.status === 'active') {
    look = {
      id: 'location-active',
      icon: 'map-marker-radius',
      tint: palette.success,
      title: 'Tus clientes ven tu avance',
      text: 'Compartiendo tu ubicación. Solo funciona con la app abierta: si la cierras o pasas a otra app, se pausa.',
    };
  } else if (t.outCount > 0 && t.status === 'starting') {
    look = {
      id: 'location-starting',
      icon: 'crosshairs-gps',
      tint: palette.cyan,
      title: 'Buscando tu ubicación…',
      text: 'En unos segundos tus clientes verán tu avance. Solo funciona con la app abierta.',
    };
  } else if (t.outCount > 0 && t.status === 'outside') {
    look = {
      id: 'location-outside',
      icon: 'earth-off',
      tint: palette.warning,
      title: 'Estás fuera de República Dominicana',
      text: 'No compartimos tu ubicación desde aquí. Tus entregas siguen funcionando igual.',
    };
  } else if (t.outCount > 0 && t.status === 'unavailable') {
    look = {
      id: 'location-unavailable',
      icon: 'crosshairs-question',
      tint: palette.warning,
      title: 'No pudimos compartir tu ubicación',
      text: t.error ?? 'Revisa que el GPS esté prendido. Seguimos intentando.',
    };
  }
  if (!look) return null;

  const body = (
    <>
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          backgroundColor: look.tint + '33',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon
          name={look.icon}
          size={20}
          color={look.tint === palette.cyan ? colors.glow : look.tint}
        />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong">{look.title}</Text>
        <Text variant="caption" muted>
          {look.text}
        </Text>
        {look.action ? (
          <Text variant="bodyStrong" color={colors.glow} style={{ marginTop: 4 }}>
            {look.action} ›
          </Text>
        ) : null}
      </View>
    </>
  );
  const frame = {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    gap: 12,
    padding: 12,
    borderRadius: radii.md,
    backgroundColor: look.tint + '1F',
    borderWidth: 1,
    borderColor: look.tint + '55',
  };
  if (look.action) {
    return (
      <Pressable
        testID={look.id}
        accessibilityRole="button"
        accessibilityLabel={`${look.title}. ${look.text}. ${look.action}`}
        onPress={() => void t.enableFromNotice()}
        style={({ pressed }) => [frame, { opacity: pressed ? 0.85 : 1, minHeight: 56 }]}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View
      testID={look.id}
      accessible
      accessibilityLabel={`${look.title}. ${look.text}`}
      style={frame}
    >
      {body}
    </View>
  );
}
