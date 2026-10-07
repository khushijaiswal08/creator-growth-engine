"use client";

import { cn } from "cn";
import { KeyRound, LogOut, PanelLeftClose, PanelLeftOpen, UserPen } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { updateProfile } from "@/actions/account";
import { BrandBadge, BrandSwitcher } from "@/components/brand-switcher";
import { FormError } from "@/components/form-error";
import { SidebarNav } from "@/components/nav";
import { SidebarContext, sidebarUi, useSidebar, type SidebarPreference } from "@/components/sidebar-context";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";

export type ShellUser = {
  name: string;
  email: string;
  role: string;
  avatarUrl: string | null;
  /** The brand on the account, when there is one. */
  brandName: string | null;
  brandShort: string | null;
  /** The brand someone with both brands is looking at. */
  viewBrand: string | null;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "")).toUpperCase();
}

/** The person's photo, or their initials on ink. */
export function UserAvatar({ user, className }: { user: { name: string; avatarUrl: string | null }; className?: string }) {
  if (user.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={user.avatarUrl} alt="" className={cn("size-8 shrink-0 rounded-full object-cover", className)} />;
  }
  return (
    <span
      aria-hidden
      className={cn("flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground font-heading text-[12px] font-medium text-background", className)}
    >
      {initials(user.name)}
    </span>
  );
}

/**
 * The frame of every signed-in page: a light sidebar on the left that the
 * person can collapse to an icon rail, and the page on the right. The choice
 * is kept in a cookie so the next page loads the same way without a jump.
 */
export function AppShell({
  user,
  isAdmin,
  initialPreference,
  logout,
  children,
}: {
  user: ShellUser;
  isAdmin: boolean;
  initialPreference: SidebarPreference;
  logout: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [preference, setPreference] = useState<SidebarPreference>(initialPreference);
  const ui = sidebarUi(preference);

  function toggle() {
    // From automatic, collapse on a wide window and expand on a narrow one: whichever is the change the person sees.
    const wideNow = typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
    const showingFull = preference === "expanded" || (preference === null && wideNow);
    const next: SidebarPreference = showingFull ? "collapsed" : "expanded";
    setPreference(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  }

  const columns =
    preference === "collapsed"
      ? "grid-cols-[3.5rem_minmax(0,1fr)]"
      : preference === "expanded"
        ? "grid-cols-[14.5rem_minmax(0,1fr)]"
        : "grid-cols-[3.5rem_minmax(0,1fr)] lg:grid-cols-[14.5rem_minmax(0,1fr)]";
  const showingFull = preference === "expanded";

  return (
    <SidebarContext.Provider value={ui}>
      <div className={cn("grid min-h-screen", columns)}>
        <aside className="sticky top-0 flex h-screen flex-col gap-6 overflow-y-auto border-r bg-surface px-2 py-4 lg:px-3 lg:py-5">
          <div className={cn("flex items-center gap-2", ui.align, preference === null && "lg:px-1")}>
            <Link
              href="/today"
              title="Creator Growth Engine"
              className="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {/* Logo mark: four blocks, like a print stamp. */}
              <span aria-hidden className="grid size-8 shrink-0 grid-cols-2 gap-px rounded-[6px] bg-foreground p-[6px]">
                <span className="rounded-[1px] bg-primary" />
                <span className="rounded-[1px] bg-background/70" />
                <span className="rounded-[1px] bg-background/70" />
                <span className="rounded-[1px] bg-primary" />
              </span>
              <span className={cn("font-heading text-[18px] leading-tight font-medium", ui.label)}>
                Creator Growth
                <span className="eyebrow block font-sans font-normal">Engine</span>
              </span>
            </Link>
            <button
              type="button"
              onClick={toggle}
              title={showingFull || preference === null ? "Collapse the sidebar" : "Expand the sidebar"}
              aria-label={showingFull || preference === null ? "Collapse the sidebar" : "Expand the sidebar"}
              className={cn(
                "ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                ui.wideOnly,
              )}
            >
              <PanelLeftClose className="size-4" strokeWidth={1.75} />
            </button>
          </div>
          {/* In the rail the toggle sits on its own row, under the mark. */}
          <button
            type="button"
            onClick={toggle}
            title="Expand the sidebar"
            aria-label="Expand the sidebar"
            className={cn(
              "-mt-3 flex h-7 w-full items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              ui.railOnly,
            )}
          >
            <PanelLeftOpen className="size-4" strokeWidth={1.75} />
          </button>

          {/* Someone tied to a brand is told which; someone who may see both chooses what the lists show. */}
          {user.brandName && user.brandShort ? (
            <BrandBadge name={user.brandName} short={user.brandShort} />
          ) : (
            <BrandSwitcher current={user.viewBrand} />
          )}

          <SidebarNav isAdmin={isAdmin} />

          <ProfileMenu user={user} logout={logout} />
        </aside>

        <main className="min-w-0 px-5 py-8 lg:px-10 lg:py-10">
          <div className="mx-auto max-w-[1120px]">{children}</div>
        </main>
      </div>
    </SidebarContext.Provider>
  );
}

const MENU_ITEM =
  "flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm text-foreground outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring";

/** The person at the bottom of the sidebar. Clicking opens their menu: profile, password, sign out. */
function ProfileMenu({ user, logout }: { user: ShellUser; logout: () => Promise<void> }) {
  const ui = useSidebar();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative mt-auto border-t pt-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${user.name} (${user.role})`}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md py-1.5 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring",
          ui.align,
          ui.preference === null ? "lg:px-2" : ui.preference === "expanded" ? "px-2" : "",
        )}
      >
        <UserAvatar user={user} />
        <span className={cn("min-w-0", ui.label)}>
          <span className="block truncate text-sm font-medium">{user.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            <span className="capitalize">{user.role}</span>
            {user.brandShort ? `, ${user.brandShort}` : ""}
          </span>
        </span>
      </button>

      {open ? (
        <div role="menu" className="card absolute bottom-full left-0 z-30 mb-2 w-64 p-1.5">
          <div className="flex items-center gap-3 px-3 py-2.5">
            <UserAvatar user={user} className="size-11 text-[15px]" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              <p className="truncate text-xs text-muted-foreground">
                <span className="capitalize">{user.role}</span>
                {user.brandName ? `, ${user.brandName}` : ""}
              </p>
            </div>
          </div>
          <div className="my-1 border-t" />
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => {
              setOpen(false);
              setEditing(true);
            }}
          >
            <UserPen className="size-4 text-muted-foreground" strokeWidth={1.75} />
            Edit profile
          </button>
          <Link href="/account/password" role="menuitem" className={MENU_ITEM} onClick={() => setOpen(false)}>
            <KeyRound className="size-4 text-muted-foreground" strokeWidth={1.75} />
            Change password
          </Link>
          <div className="my-1 border-t" />
          <form action={logout}>
            <button type="submit" role="menuitem" className={MENU_ITEM}>
              <LogOut className="size-4 text-muted-foreground" strokeWidth={1.75} />
              Sign out
            </button>
          </form>
        </div>
      ) : null}

      <EditProfileDialog user={user} open={editing} onOpenChange={setEditing} />
    </div>
  );
}

const AVATAR_SIZE = 160;

/** Shrinks a chosen picture to a small square JPEG in the browser, so only a few kilobytes are stored. */
async function shrinkImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("unreadable"));
      element.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const side = Math.min(image.width, image.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function EditProfileDialog({ user, open, onOpenChange }: { user: ShellUser; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [state, action] = useActionState(updateProfile, null);
  const [preview, setPreview] = useState<string | null>(user.avatarUrl);
  const [avatar, setAvatar] = useState("");
  const [remove, setRemove] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const savedMessage = state?.message;

  useEffect(() => {
    if (savedMessage && open) {
      onOpenChange(false);
      router.refresh();
    }
    // Close once, when a save succeeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedMessage]);

  useEffect(() => {
    if (open) {
      setPreview(user.avatarUrl);
      setAvatar("");
      setRemove(false);
      setReadError(null);
    }
  }, [open, user.avatarUrl]);

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setReadError(null);
    try {
      const shrunk = await shrinkImage(file);
      setAvatar(shrunk);
      setPreview(shrunk);
      setRemove(false);
    } catch {
      setReadError("That picture could not be read. Try a JPEG or PNG.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Your profile</DialogTitle>
          <DialogDescription>Your name and photo, as the team sees them. Email and role are changed by an admin.</DialogDescription>
        </DialogHeader>
        <form action={action} className="grid gap-4">
          <input type="hidden" name="avatar" value={avatar} />
          <input type="hidden" name="removeAvatar" value={remove ? "1" : ""} />
          <div className="flex items-center gap-4">
            <UserAvatar user={{ name: user.name, avatarUrl: preview }} className="size-16 text-[20px]" />
            <div className="grid gap-1.5">
              <Label htmlFor="profile-photo">Photo</Label>
              <Input id="profile-photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={onPick} className="h-auto py-1.5" />
              {preview ? (
                <button
                  type="button"
                  className="justify-self-start text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setPreview(null);
                    setAvatar("");
                    setRemove(true);
                  }}
                >
                  Remove photo
                </button>
              ) : null}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="profile-name">Name</Label>
            <Input id="profile-name" name="name" defaultValue={user.name} required maxLength={120} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="profile-email">Email</Label>
            <Input id="profile-email" value={user.email} readOnly className="text-muted-foreground" />
          </div>
          {readError ? (
            <p role="alert" className="text-sm text-destructive">
              {readError}
            </p>
          ) : null}
          <FormError state={state} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <SubmitButton variant="action" pendingLabel="Saving...">
              Save
            </SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
