import { useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import {
  Button,
  Card,
  Icon,
  Skeleton,
  Text,
  liveAgeSeconds,
  mapsUrl,
  trackingHeadline,
  trackingUnavailableText,
  useTheme,
} from '@jellyfish/mobile-core';
import { useTracking } from '../api/hooks';

/**
 * Seguimiento del pedido en camino. Consulta la posición del repartidor cada ~15 s; con posición
 * ofrece abrir el mapa del teléfono (Apple Maps en iPhone, Google Maps en Android y web). Sin
 * posición explica por qué, en lenguaje claro. No hay mapa embebido.
 */
export function TrackingCard({ orderId }: { orderId: string }) {
  const { colors, palette } = useTheme();
  const tracking = useTracking(orderId, true);
  const [now, setNow] = useState(() => Date.now());

  // "hace X s" sigue corriendo entre consulta y consulta.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const data = tracking.data;
  const available = data?.available === true ? data : null;
  const url = available
    ? mapsUrl(Platform.OS, available.latitude, available.longitude, 'Tu repartidor')
    : null;

  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }} testID="tracking-card">
        <View
          style={{
            width: 46,
            height: 46,
            borderRadius: 23,
            backgroundColor: colors.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="truck-delivery" size={26} color={colors.glow} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="heading">Seguimiento en vivo</Text>
          {tracking.isLoading ? (
            <Skeleton height={16} width="70%" radius={8} />
          ) : available ? (
            <Text testID="tracking-headline" accessibilityLiveRegion="polite">
              {trackingHeadline(liveAgeSeconds(available.ageSeconds, tracking.dataUpdatedAt, now))}
            </Text>
          ) : data && !data.available ? (
            <Text muted testID="tracking-unavailable">
              {trackingUnavailableText(data.reason)}
            </Text>
          ) : (
            <Text muted testID="tracking-error">
              No pudimos consultar la ubicación de tu repartidor. Lo intentaremos de nuevo en unos
              segundos.
            </Text>
          )}
        </View>
        {available ? (
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: palette.success,
            }}
            accessibilityElementsHidden
          />
        ) : null}
      </View>
      {url ? (
        <Button
          title="Ver en el mapa"
          icon="map-marker-radius"
          variant="secondary"
          testID="tracking-map"
          onPress={() => {
            void Linking.openURL(url).catch(() => {});
          }}
        />
      ) : null}
    </Card>
  );
}
