import { resolveFavorites } from '@jellyfish/mobile-core';
import { router } from 'expo-router';
import { FlatList, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  EmptyState,
  ErrorState,
  Header,
  Skeleton,
  Text,
  errorMessage,
  useTheme,
} from '@jellyfish/mobile-core';
import { useProducts } from '../src/api/hooks';
import { LocalFavoritesNote } from '../src/components/LocalFavoritesNote';
import { ProductCard } from '../src/components/ProductCard';
import { useFavorites } from '../src/store/favorites';

/** "Mis favoritos": los productos que marcaste con el corazón (solo en este teléfono). */
export default function Favorites() {
  const { colors, spacing } = useTheme();
  const groups = useFavorites((s) => s.groups);
  const products = useProducts({ limit: 100 });
  const items = resolveFavorites(groups, products.data?.items ?? []);

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={['top', 'left', 'right']}
    >
      <View style={{ paddingHorizontal: spacing.lg }}>
        <Header title="Mis favoritos" />
      </View>
      {groups.length === 0 ? (
        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
          <EmptyState
            icon="heart-outline"
            title="Aún no tienes favoritos"
            text="Toca el corazón en cualquier producto para guardarlo aquí y volver a él en un toque."
            action="Ver productos"
            onAction={() => router.push('/search')}
          />
          <LocalFavoritesNote />
        </View>
      ) : products.isLoading ? (
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
        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
          <EmptyState
            icon="heart-broken-outline"
            title="Tus favoritos ya no están a la venta"
            text="Los productos que guardaste no están disponibles por ahora. Mira lo que tenemos hoy."
            action="Ver productos"
            onAction={() => router.push('/search')}
          />
          <LocalFavoritesNote />
        </View>
      ) : (
        <FlatList
          testID="favorites-list"
          data={items}
          keyExtractor={(p) => p.group}
          numColumns={2}
          columnWrapperStyle={{ gap: 12 }}
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            gap: 12,
            paddingBottom: spacing.xxl * 2,
          }}
          ListHeaderComponent={
            <View style={{ gap: spacing.md, marginBottom: spacing.sm }}>
              <Text variant="caption" muted>
                {items.length} {items.length === 1 ? 'producto' : 'productos'}
              </Text>
              <LocalFavoritesNote />
            </View>
          }
          renderItem={({ item }) => <ProductCard product={item} />}
        />
      )}
    </SafeAreaView>
  );
}
