import { useState, useCallback } from 'react';
import { toast } from "react-hot-toast";
import { useQueryClient } from "@tanstack/react-query";

// Utiliser la valeur de l'environnement ou par défaut 20 minutes
const MANUAL_REFRESH_COOLDOWN = (Number(process.env.NEXT_PUBLIC_MANUAL_RSS_REFRESH_MINUTES) || 20) * 60 * 1000;
const LAST_REFRESH_KEY = 'last_rss_refresh';

export const useRSSRefresh = () => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const getLastRefreshTime = useCallback((): number => {
    const lastRefresh = localStorage.getItem(LAST_REFRESH_KEY);
    return lastRefresh ? parseInt(lastRefresh) : 0;
  }, []);

  const setLastRefreshTime = useCallback((): void => {
    localStorage.setItem(LAST_REFRESH_KEY, Date.now().toString());
  }, []);

  const canRefresh = useCallback((): boolean => {
    if (isRefreshing) return false;
    
    const lastRefresh = getLastRefreshTime();
    const timeSinceLastRefresh = Date.now() - lastRefresh;
    return timeSinceLastRefresh >= MANUAL_REFRESH_COOLDOWN;
  }, [isRefreshing, getLastRefreshTime]);

  const getTimeUntilNextRefresh = useCallback((): number => {
    const lastRefresh = getLastRefreshTime();
    const timeSinceLastRefresh = Date.now() - lastRefresh;
    return Math.max(0, MANUAL_REFRESH_COOLDOWN - timeSinceLastRefresh);
  }, [getLastRefreshTime]);

  const refreshFeeds = useCallback(async (): Promise<boolean> => {
    if (!canRefresh()) {
      const waitTime = Math.ceil(getTimeUntilNextRefresh() / 1000 / 60);
      toast.error(`Veuillez attendre encore ${waitTime} minutes avant de rafraîchir`);
      return false;
    }

    try {
      setIsRefreshing(true);
      const loadingToast = toast.loading("Rafraîchissement des flux RSS en cours...");

      const response = await fetch('/api/v1/rss/refresh', {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Erreur lors du rafraîchissement des flux');
      }

      const data = await response.json();
      
      // Analyser les résultats
      let newItemsCount = 0;
      let errorsCount = 0;
      
      data.details.forEach((result: any) => {
        if (result.status === 'fulfilled') {
          const value = result.value;
          if (value.status === 'success') {
            newItemsCount += value.newItems || 0;
          } else if (value.status === 'skipped') {
            console.log(`Flux ${value.subscription} ignoré: ${value.reason}`);
          } else if (value.status === 'error' && value.error?.includes('ENOTFOUND')) {
            errorsCount++;
            console.error(`Erreur de connexion au flux ${value.subscription}: ${value.error}`);
          }
        } else if (result.status === 'rejected') {
          errorsCount++;
          console.error(`Erreur critique sur un flux RSS:`, result.reason);
        }
      });

      toast.dismiss(loadingToast);

      // Afficher le résultat
      if (newItemsCount > 0) {
        toast.success(`${newItemsCount} nouveaux articles importés`);
        // Invalider le cache des liens pour forcer un rechargement
        await queryClient.invalidateQueries({ queryKey: ['links'] });
      } else {
        toast.success('Aucun nouvel article à importer');
      }

      if (errorsCount > 0) {
        toast.error(`${errorsCount} flux RSS inaccessible${errorsCount > 1 ? 's' : ''}`);
      }

      setLastRefreshTime();
      return true;

    } catch (error) {
      console.error('Erreur lors du rafraîchissement des flux:', error);
      toast.error("Erreur lors du rafraîchissement des flux");
      return false;

    } finally {
      setIsRefreshing(false);
    }
  }, [canRefresh, getTimeUntilNextRefresh, setLastRefreshTime, queryClient]);

  return {
    isRefreshing,
    canRefresh,
    getTimeUntilNextRefresh,
    refreshFeeds
  };
}; 