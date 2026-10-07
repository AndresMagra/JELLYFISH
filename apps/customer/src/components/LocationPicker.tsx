import { isInDominicanRepublic } from '@jellyfish/shared';
import { useState } from 'react';
import { View } from 'react-native';
import {
  BottomSheet,
  Button,
  Card,
  Icon,
  LocationError,
  Text,
  ensureForegroundLocationPermission,
  formatCoords,
  getCurrentPosition,
  getForegroundLocationPermission,
  openAppSettings,
  success,
  useTheme,
} from '@jellyfish/mobile-core';

export interface PickedLocation {
  latitude: number;
  longitude: number;
  /** Precisión del GPS en metros, si el teléfono la dio. */
  accuracyM: number | null;
}

type Problem = 'denied' | 'blocked' | 'outside' | 'failed';

const PROBLEM_TEXT: Record<Problem, string> = {
  denied:
    'No tenemos permiso para ver tu ubicación. No pasa nada: escribe tu dirección a mano y listo.',
  blocked:
    'La ubicación está apagada para JELLYFISH en tu teléfono. Puedes activarla en Ajustes o escribir tu dirección a mano.',
  outside:
    'Tu ubicación parece estar fuera de República Dominicana, así que no la guardamos. Escribe tu dirección a mano.',
  failed:
    'No pudimos leer tu ubicación. Revisa que el GPS esté prendido o escribe tu dirección a mano.',
};

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * "Usar mi ubicación actual": pide el permiso explicándolo antes, lee la posición UNA vez, la valida
 * (tiene que estar dentro de RD) y devuelve solo las coordenadas. El formulario nunca depende de esto.
 */
export function LocationPicker({
  value,
  onChange,
}: {
  value: PickedLocation | null;
  onChange: (next: PickedLocation | null) => void;
}) {
  const { colors, palette } = useTheme();
  const [explain, setExplain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  const locate = async () => {
    setBusy(true);
    setProblem(null);
    setDetail(null);
    try {
      const fix = await getCurrentPosition();
      if (!isInDominicanRepublic(fix.latitude, fix.longitude)) {
        setProblem('outside');
        return;
      }
      onChange({
        latitude: round6(fix.latitude),
        longitude: round6(fix.longitude),
        accuracyM: fix.accuracyM,
      });
      success();
    } catch (e) {
      setProblem('failed');
      if (e instanceof LocationError) setDetail(e.message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setProblem(null);
    setDetail(null);
    const state = await getForegroundLocationPermission();
    if (state === 'granted') return locate();
    if (state === 'blocked') return setProblem('blocked');
    setExplain(true); // primero le explicamos; el diálogo del sistema aparece solo una vez
  };

  const allow = async () => {
    setExplain(false);
    setBusy(true);
    const r = await ensureForegroundLocationPermission();
    setBusy(false);
    if (!r.granted) return setProblem(r.state === 'blocked' ? 'blocked' : 'denied');
    await locate();
  };

  const poor = value?.accuracyM != null && value.accuracyM > 150;

  return (
    <>
      {value ? (
        <Card style={{ gap: 10, borderColor: palette.success, borderWidth: 1 }}>
          <View
            testID="location-saved"
            style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}
          >
            <Icon name="map-marker-check" size={28} color={palette.success} />
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">Ubicación guardada ✓</Text>
              <Text variant="caption" muted>
                {formatCoords(value.latitude, value.longitude)}
                {value.accuracyM != null && value.accuracyM >= 1
                  ? ` · precisión de unos ${Math.round(value.accuracyM)} m`
                  : ''}
              </Text>
            </View>
          </View>
          <Text variant="caption" muted>
            Solo guardamos el punto, para que el repartidor llegue más rápido. Sigue escribiendo la
            calle, el sector y una buena referencia.
          </Text>
          {poor ? (
            <Text variant="caption" color={palette.warning}>
              La precisión es baja. Si estás dentro de un edificio, acércate a una ventana y vuelve
              a intentarlo.
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              title="Actualizar"
              icon="crosshairs-gps"
              variant="secondary"
              small
              loading={busy}
              onPress={() => void locate()}
              style={{ flex: 1 }}
            />
            <Button
              title="Quitar"
              icon="map-marker-off"
              variant="ghost"
              small
              onPress={() => onChange(null)}
              testID="location-remove"
              style={{ flex: 1 }}
            />
          </View>
        </Card>
      ) : (
        <View style={{ gap: 8 }}>
          <Button
            title="Usar mi ubicación actual"
            icon="crosshairs-gps"
            variant="secondary"
            loading={busy}
            onPress={() => void start()}
            testID="use-location"
          />
          <Text variant="caption" muted>
            Opcional. Guarda el punto exacto de tu casa para que el repartidor llegue más rápido.
          </Text>
        </View>
      )}

      {problem ? (
        <Card style={{ gap: 8, flexDirection: 'row' }}>
          <Icon name="map-marker-alert-outline" size={22} color={palette.warning} />
          <View style={{ flex: 1, gap: 8 }}>
            <Text testID="location-problem">{PROBLEM_TEXT[problem]}</Text>
            {detail ? (
              <Text variant="caption" muted>
                {detail}
              </Text>
            ) : null}
            {problem === 'blocked' ? (
              <Button
                title="Abrir ajustes"
                icon="cog-outline"
                variant="secondary"
                small
                onPress={openAppSettings}
              />
            ) : null}
          </View>
        </Card>
      ) : null}

      <BottomSheet
        visible={explain}
        onClose={() => setExplain(false)}
        icon="crosshairs-gps"
        title="¿Usar tu ubicación?"
        testID="location-explain"
        footer={
          <>
            <Button
              title="Permitir y usar mi ubicación"
              onPress={() => void allow()}
              testID="location-allow"
            />
            <Button title="Ahora no" variant="ghost" onPress={() => setExplain(false)} />
          </>
        }
      >
        <Text>
          Vamos a leer tu ubicación <Text variant="bodyStrong">una sola vez</Text>, ahora, para
          guardar el punto de tu casa y que el repartidor te encuentre más fácil.
        </Text>
        <View style={{ gap: 8, marginTop: 4 }}>
          {[
            'No te seguimos ni la leemos mientras no usas esto.',
            'Solo se guardan las coordenadas con tu dirección; puedes quitarlas cuando quieras.',
            'Si prefieres no darla, puedes escribir tu dirección a mano.',
          ].map((t) => (
            <View key={t} style={{ flexDirection: 'row', gap: 8 }}>
              <Icon name="check-circle-outline" size={18} color={colors.glow} />
              <Text variant="caption" style={{ flex: 1 }}>
                {t}
              </Text>
            </View>
          ))}
        </View>
      </BottomSheet>
    </>
  );
}
