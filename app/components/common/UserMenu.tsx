"use client";
import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { useAuth } from "@/hooks/useAuth";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

export function UserMenu() {
  const t = useTranslations('userMenu');
  const { user, profile, signOut, loading } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleSignOut = async () => {
    setIsLoggingOut(true);
    try {
      await signOut();
      window.location.href = "/";
    } catch (error) {
      console.error("Error signing out:", error);
      setIsLoggingOut(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 sm:gap-3 p-1 sm:p-1.5 h-11">
        <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-white/10 animate-pulse border border-white/5 shrink-0"></div>
        <div className="hidden sm:block w-24 h-4 rounded-md bg-white/10 animate-pulse"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center gap-2 sm:gap-4 h-11">
        <Button variant="primary" asChild>
          <Link
            href="/login"
            className="text-md font-medium text-white hover:text-white/90 transition-colors"
          >
            {t('login')}
          </Link>
        </Button>
      </div>
    );
  }

  const meta = user.user_metadata || {};
  const displayName = profile?.first_name || profile?.full_name || meta.full_name || meta.name || user.email?.split("@")[0] || t('defaultUser');
  const avatarUrl = profile?.avatar_url || meta.avatar_url || meta.picture || `https://api.dicebear.com/7.x/initials/svg?seed=${displayName}`;
  const provider = profile?.provider || meta.provider || "email";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="flex items-center gap-2 sm:gap-3 p-1 sm:p-1.5 rounded-full hover:bg-white/5 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500/50"
          aria-label={t('ariaLabel')}
        >
          <div className="relative w-8 h-8 sm:w-9 sm:h-9 rounded-full overflow-hidden border border-white/10 hover:border-white/30 transition-colors">
            <Image src={avatarUrl} alt={displayName} fill sizes="36px" className="object-cover" />
          </div>
          <span className="hidden sm:block text-sm font-medium text-neutral-300 max-w-30 truncate">
            {displayName}
          </span>
          <Icon icon="solar:alt-arrow-down-linear" className="hidden sm:block size-4 text-neutral-400" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="min-w-50 bg-black border border-white/25 rounded-xl p-1 shadow-2xl z-50 animate-in fade-in slide-in-from-top-2 duration-200"
          sideOffset={8}
          align="end"
        >
          <div className="px-3 py-2 mb-1 border-b border-white/10">
            <p className="text-sm font-medium text-white truncate">{displayName}</p>
            <p className="text-xs text-neutral-400 truncate">{user.email}</p>
            <p className="text-xs text-neutral-500 mt-1 capitalize">
              {t('connectedWith', { provider })}
            </p>
          </div>

          <DropdownMenu.Item asChild>
            <Link
              href="/"
              className="flex items-center gap-3 px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors cursor-pointer outline-none"
            >
              <Icon icon="hugeicons:home-11" className="size-4" aria-hidden="true" />
              {t('home')}
            </Link>
          </DropdownMenu.Item>

          <DropdownMenu.Item asChild>
            <Link
              href="/projects"
              className="flex items-center gap-3 px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors cursor-pointer outline-none"
            >
              <Icon icon="solar:video-frame-cut-2-linear" className="size-4" aria-hidden="true" />
              <span>Projects</span>
            </Link>
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="h-px bg-white/5 my-1" />

          <DropdownMenu.Item asChild>
            <button
              onClick={handleSignOut}
              disabled={isLoggingOut}
              className="w-full flex items-center gap-3 px-3 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            >
            {isLoggingOut ? (
              <>
                <Icon icon="svg-spinners:ring-resize" className="size-4" aria-hidden="true" />
                <span>{t('loggingOut')}</span>
              </>
            ) : (
              <>
                <Icon icon="solar:logout-2-linear" className="size-4" aria-hidden="true" />
                <span>{t('logout')}</span>
              </>
            )}
            </button>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
