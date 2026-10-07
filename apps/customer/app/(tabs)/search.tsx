import type { ProductDTO } from '@jellyfish/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Chip,
  EmptyState,
  ErrorState,
  Skeleton,
  Text,
  TextField,
  errorMessage,
  useTheme,
} from '@jellyfish/mobile-core';
import { CategoryGlyph } from '../../src/components/CategoryIcon';
import { useCategories, useProducts } from '../../src/api/hooks';
import { ProductCard } from '../../src/components/ProductCard';

/** Espera a que la persona deje de escribir antes de consultar. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function Search() {
  const { colors, spacing } = useTheme();
  const params = useLocalSearchParams<{ category?: string }>();
  const [text, setText] = useState('');
  const [category, setCategory] = useState<string | undefined>(params.category);
  const q = useDebounced(text.trim(), 250);

  // Llegar desde "Ver todo" / una categoría del inicio cambia el filtro.
  useEffect(() => {
    setCategory(params.category || undefined);
  }, [params.category]);

  const cats = useCategories();
  const products = useProducts({ q: q || undefined, category });
  const items = products.data?.items ?? [];

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={['top', 'left', 'right']}
    >
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.md }}>
        <Text variant="display">Buscar</Text>
        <TextField
          value={text}
          onChangeText={setText}
          placeholder="Pechuga, camarón 26/30, costilla…"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          testID="search-input"
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingBottom: 4 }}
        >
          <Chip
            label="Todo"
            selected={!category}
            onPress={() => {
              setCategory(undefined);
              router.setParams({ category: '' });
            }}
          />
          {(cats.data ?? []).map((c) => (
            <Chip
              key={c.slug}
              label={c.name}
              selected={category === c.slug}
              onPress={() => {
                setCategory(category === c.slug ? undefined : c.slug);
                router.setParams({ category: '' });
              }}
              icon={
                <CategoryGlyph
                  slug={c.slug}
                  size={14}
                  color={category === c.slug ? colors.onPrimary : colors.glow}
                />
              }
            />
          ))}
        </ScrollView>
      </View>

      {products.isLoading ? (
        <View style={{ padding: spacing.lg, flexDirection: 'row', gap: 12 }}>
          <Skeleton height={230} width="47%" radius={24} />
          <Skeleton height={230} width="47%" radius={24} />
        </View>
      ) : products.isError ? (
        <ErrorState
          message={errorMessage(products.error)}
          onRetry={() => void products.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon="magnify"
          title="No encontramos eso"
          text={
            q
              ? `Nada coincide con “${q}”. Prueba con otra palabra: pollo, res, camarones…`
              : 'No hay productos en esta categoría por ahora.'
          }
          action={q || category ? 'Ver todo' : undefined}
          onAction={() => {
            setText('');
            setCategory(undefined);
          }}
        />
      ) : (
        <FlatList<ProductDTO>
          testID="search-results"
          data={items}
          keyExtractor={(p) => p.group}
          numColumns={2}
          columnWrapperStyle={{ gap: 12 }}
          contentContainerStyle={{ padding: spacing.lg, gap: 12, paddingBottom: spacing.xxl * 2 }}
          renderItem={({ item }) => <ProductCard product={item} />}
          ListHeaderComponent={
            <Text variant="caption" muted style={{ marginBottom: 4 }}>
              {products.data?.total} {products.data?.total === 1 ? 'producto' : 'productos'}
            </Text>
          }
          keyboardShouldPersistTaps="handled"
        />
      )}
    </SafeAreaView>
  );
}
