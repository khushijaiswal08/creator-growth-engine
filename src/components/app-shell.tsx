"use client";

import { cn } from "cn";
import { BarChart3, Bell, Clapperboard, Gift, Kanban, KeyRound, LayoutDashboard, LogOut, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Search, Settings, SlidersHorizontal, Upload, UserPen, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { updateProfile } from "@/actions/account";
import { BrandBadge, BrandSegments, BrandSwitcher } from "@/components/brand-switcher";
import { RachnaCameo, RachnaProvider, RachnaSlot, RachnaStrip } from "@/components/rachna/rachna";
import { FormError } from "@/components/form-error";
import { SidebarNav } from "@/components/nav";
import { SidebarContext, sidebarUi, useSidebar, type SidebarPreference } from "@/components/sidebar-context";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RachnaCounts } from "@/lib/rachna";
import { SIDEBAR_COOKIE } from "@/lib/sidebar";

export type ShellUser = {
  id: string;
  name: string;
  email: string;
  /** Whether Rachna, the guide, shows her notes and nudges. */
  rachnaTips: boolean;
  role: string;
  avatarUrl: string | null;
  /** The brand on the account, when there is one. */
  brandName: string | null;
  brandShort: string | null;
  /** The brand someone with both brands is looking at. */
  viewBrand: string | null;
};

/** The two figures the frame shows on every page. */
export type ShellStats = {
  /** Creators whose next step is due now, within what the person sees. */
  due: number;
  /** Messages this person logged since Monday, against the brand's weekly target. */
  weekSent: number;
  weekTarget: number;
  /** The live counts behind Rachna's quests and her mood. */
  rachna: RachnaCounts;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "")).toUpperCase();
}

/** The person's photo, or their initials on rose. */
export function UserAvatar({ user, className }: { user: { name: string; avatarUrl: string | null }; className?: string }) {
  if (user.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={user.avatarUrl} alt="" className={cn("size-8 shrink-0 rounded-full object-cover", className)} />;
  }
  return (
    <span aria-hidden className={cn("flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[12px] font-bold text-primary-text", className)}>
      {initials(user.name)}
    </span>
  );
}

/**
 * The frame of every signed-in page: a top bar with search, the brand, the
 * bell and the profile; a light sidebar on the left that the person can
 * collapse to an icon rail (the choice is kept in a cookie). On a phone the
 * sidebar becomes a bar along the bottom with a "More" drawer.
 */
export function AppShell({
  user,
  isAdmin,
  initialPreference,
  stats,
  rachnaIntro,
  logout,
  children,
}: {
  user: ShellUser;
  isAdmin: boolean;
  initialPreference: SidebarPreference;
  stats: ShellStats;
  /** True on the first visit after signing in: Rachna introduces herself. */
  rachnaIntro: boolean;
  logout: () => Promise<void>;
  children: React.ReactNode;
}) {
  const [preference, setPreference] = useState<SidebarPreference>(initialPreference);
  const [editing, setEditing] = useState(false);
  const ui = sidebarUi(preference);

  function toggle() {
    // From automatic, collapse on a wide window and expand on a narrow one: whichever is the change the person sees.
    const wideNow = typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
    const showingFull = preference === "expanded" || (preference === null && wideNow);
    const next: SidebarPreference = showingFull ? "collapsed" : "expanded";
    setPreference(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  }

  const width = preference === "collapsed" ? "md:w-[72px]" : preference === "expanded" ? "md:w-[248px]" : "md:w-[72px] lg:w-[248px]";
  const collapsed = preference === "collapsed";

  return (
    <SidebarContext.Provider value={ui}>
      <RachnaProvider userId={user.id} tipsOn={user.rachnaTips} counts={stats.rachna} intro={rachnaIntro}>
      <div className="flex min-h-screen">
        {/* The sidebar runs the full height: the logo on top, the places, then Rachna and the week at the foot. */}
        <aside className={cn("group/side sticky top-0 hidden h-screen shrink-0 flex-col overflow-y-auto border-r bg-surface px-3.5 pt-3.5 pb-4 md:flex", width)}>
          <SidebarHead collapsed={collapsed} onToggle={toggle} />
          <SidebarNav isAdmin={isAdmin} counts={{ "/today": stats.due, "/orders": stats.rachna.approvals }} />
          <div className="mt-auto pt-5">
            <RachnaSlot />
            <WeekBox sent={stats.weekSent} target={stats.weekTarget} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar user={user} due={stats.due} logout={logout} onEdit={() => setEditing(true)} />
          <main className="min-w-0 flex-1 px-4 pt-5 pb-24 md:px-8 md:pt-8 md:pb-16">
            <RachnaStrip />
            <div className="mx-auto max-w-[1320px]">{children}</div>
          </main>
        </div>

        <MobileBar user={user} isAdmin={isAdmin} logout={logout} onEdit={() => setEditing(true)} />
        <EditProfileDialog user={user} open={editing} onOpenChange={setEditing} />
      </div>
      </RachnaProvider>
    </SidebarContext.Provider>
  );
}

/** The top of the sidebar: the logo and its name, and the button that folds the sidebar to an icon rail. */
function SidebarHead({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const ui = useSidebar();
  const label = collapsed ? "Expand the sidebar" : "Collapse the sidebar";
  // In the icon rail the mark and the button stack; in the full column they share a line.
  const stack = ui.preference === "collapsed" ? "flex-col" : ui.preference === "expanded" ? "" : "flex-col lg:flex-row";
  // In the full column the button floats at the right and shows on hover, so the name keeps its room.
  const push =
    ui.preference === "collapsed"
      ? ""
      : ui.preference === "expanded"
        ? "absolute top-1/2 right-0 -translate-y-1/2 opacity-0 group-hover/side:opacity-100 focus-visible:opacity-100"
        : "lg:absolute lg:top-1/2 lg:right-0 lg:-translate-y-1/2 lg:opacity-0 lg:group-hover/side:opacity-100 lg:focus-visible:opacity-100";
  return (
    <div className={cn("relative mb-3 flex items-center gap-2.5 px-1.5 pt-1 pb-2", stack)}>
      <Link href="/today" title="Creator Growth Engine" className="flex min-w-0 items-center gap-3 rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35">
        <Mark />
        <span className={cn("min-w-0", ui.label)}>
          <span className="block text-[15px] leading-tight font-extrabold tracking-[-0.01em] text-foreground">Creator Growth</span>
          <span className="block truncate text-[11.5px] font-semibold text-muted-foreground">Ridhi · Cotton Print Club</span>
        </span>
      </Link>
      <button type="button" onClick={onToggle} title={label} aria-label={label} className={cn(ICON_BUTTON, "size-8 rounded-lg bg-surface shadow-[0_1px_2px_rgba(15,23,42,0.08)]", push)}>
        {collapsed ? <PanelLeftOpen className="size-[17px]" strokeWidth={1.9} /> : <PanelLeftClose className="size-[17px]" strokeWidth={1.9} />}
      </button>
    </div>
  );
}

/** Logo mark: four blocks on rose, like a print stamp. */
function Mark({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("grid size-9 shrink-0 grid-cols-2 gap-[3px] rounded-[11px] bg-gradient-to-br from-[#c95f84] to-primary-deep p-2 shadow-[0_6px_14px_rgba(178,74,107,0.32)]", className)}>
      <span className="rounded-[2px] bg-surface" />
      <span className="rounded-[2px] bg-[#f9d3e0]" />
      <span className="rounded-[2px] bg-[#f9d3e0]" />
      <span className="rounded-[2px] bg-surface" />
    </span>
  );
}

const ICON_BUTTON = "relative flex size-[42px] shrink-0 items-center justify-center rounded-xl border bg-surface text-accent-text outline-none transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/35";

function TopBar({
  user,
  due,
  logout,
  onEdit,
}: {
  user: ShellUser;
  due: number;
  logout: () => Promise<void>;
  onEdit: () => void;
}) {
  const search = useRef<HTMLInputElement>(null);

  // Ctrl+K (Cmd+K on a Mac) puts the cursor in the search box from anywhere.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-surface/90 px-4 backdrop-blur md:h-[68px] md:px-8">
      {/* Phones have no sidebar, so the logo sits here. */}
      <Link href="/today" title="Creator Growth Engine" className="flex items-center gap-2.5 rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 md:hidden">
        <Mark />
      </Link>

      <form action="/search" method="get" role="search" className="relative hidden min-w-0 flex-[0_1_440px] md:block">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-muted-foreground" strokeWidth={2} />
        <input
          ref={search}
          type="search"
          name="q"
          aria-label="Search"
          placeholder="Search creators, campaigns, orders"
          className="h-[42px] w-full rounded-xl border border-transparent bg-surface-2 pr-16 pl-11 text-sm font-medium outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary focus-visible:bg-surface focus-visible:ring-[3px] focus-visible:ring-ring/20"
        />
        <kbd aria-hidden className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded-md border bg-surface px-1.5 font-sans text-[11px] font-extrabold text-muted-foreground lg:block">
          Ctrl K
        </kbd>
      </form>

      <div className="flex items-center">
        {user.brandName ? (
          <span className="hidden sm:block">
            <BrandBadge name={user.brandName} />
          </span>
        ) : (
          <span className="hidden md:block">
            <BrandSegments current={user.viewBrand} />
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2 md:gap-2.5">
        <Link href="/search" aria-label="Search" className={cn(ICON_BUTTON, "md:hidden")}>
          <Search className="size-[18px]" strokeWidth={2} />
        </Link>
        <RachnaCameo />
        <Link href="/today" title={due === 0 ? "Nothing is due right now" : `${due} ${due === 1 ? "thing needs" : "things need"} you today`} aria-label={due === 0 ? "Nothing is due" : `${due} due today`} className={ICON_BUTTON}>
          <Bell className="size-[18px]" strokeWidth={1.9} />
          {due > 0 ? (
            <span aria-hidden className="absolute -top-1.5 -right-2 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-surface bg-[#e11d48] px-1 text-[10.5px] leading-none font-extrabold text-white">
              {due > 99 ? "99+" : due}
            </span>
          ) : null}
        </Link>
        <ProfileMenu user={user} logout={logout} onEdit={onEdit} />
      </div>
    </header>
  );
}

/** The sidebar's foot: this person's week against the target. Hidden in the icon rail. */
function WeekBox({ sent, target }: { sent: number; target: number }) {
  const ui = useSidebar();
  const share = target > 0 ? Math.min(1, sent / target) : 0;
  return (
    <div className={cn("mt-3 rounded-2xl border bg-[#fbfbfc] px-3.5 py-3", ui.wideOnly)}>
      <p className="flex items-center justify-between">
        <span className="label">This week</span>
        {target > 0 ? <span className="text-xs font-bold text-muted-foreground tabular-nums">{Math.round(share * 100)}%</span> : null}
      </p>
      <p className="mt-1 mb-2 flex items-baseline gap-1.5">
        <span className="text-[20px] leading-none font-extrabold text-foreground tabular-nums">{sent}</span>
        <span className="font-semibold text-muted-foreground">{target > 0 ? `of ${target} messages` : "messages"}</span>
      </p>
      {target > 0 ? (
        <span aria-hidden className="block h-2 overflow-hidden rounded-full bg-[#eceff3]">
          <span className="block h-full rounded-full bg-gradient-to-r from-[#c95f84] to-primary" style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
      ) : null}
    </div>
  );
}

const MENU_ITEM = "flex h-11 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm text-foreground outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring md:h-9";

/** The person at the right of the top bar. Clicking opens their menu: profile, password, sign out. */
function ProfileMenu({ user, logout, onEdit }: { user: ShellUser; logout: () => Promise<void>; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
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
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${user.name} (${user.role})`}
        className="flex h-[42px] items-center gap-2.5 rounded-xl pr-1 pl-1 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:ring-[3px] focus-visible:ring-ring/35 md:pr-2.5"
      >
        <UserAvatar user={user} className="size-[38px] text-[12.5px] font-extrabold" />
        <span className="hidden min-w-0 lg:block">
          <span className="block max-w-[150px] truncate text-[13.5px] leading-tight font-bold">{user.name}</span>
          <span className="block truncate text-xs leading-tight text-muted-foreground">
            <span className="capitalize">{user.role}</span>
            {user.brandShort ? `, ${user.brandShort}` : ""}
          </span>
        </span>
      </button>

      {open ? (
        <div role="menu" className="card absolute top-full right-0 z-40 mt-2 w-64 p-1.5 shadow-lg">
          <ProfileItems user={user} logout={logout} onEdit={() => { setOpen(false); onEdit(); }} onNavigate={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

function ProfileItems({ user, logout, onEdit, onNavigate }: { user: ShellUser; logout: () => Promise<void>; onEdit: () => void; onNavigate: () => void }) {
  return (
    <>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <UserAvatar user={user} className="size-11 text-[15px]" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{user.name}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          <p className="truncate text-xs text-muted-foreground">
            <span className="capitalize">{user.role}</span>
            {user.brandName ? `, ${user.brandName}` : ""}
          </p>
        </div>
      </div>
      <div className="my-1 border-t" />
      <button type="button" role="menuitem" className={MENU_ITEM} onClick={onEdit}>
        <UserPen className="size-4 text-muted-foreground" strokeWidth={1.75} />
        Edit profile
      </button>
      <Link href="/account/password" role="menuitem" className={MENU_ITEM} onClick={onNavigate}>
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
    </>
  );
}

const BAR_LINKS = [
  { href: "/today", label: "Home", icon: LayoutDashboard },
  { href: "/influencers", label: "Creators", icon: Users },
  { href: "/campaigns", label: "Pipeline", icon: Kanban },
  { href: "/orders", label: "Gifts", icon: Gift },
];
const DRAWER_LINKS = [
  { href: "/content", label: "Content", icon: Clapperboard },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/import", label: "Import", icon: Upload },
  { href: "/settings", label: "Settings", icon: SlidersHorizontal },
];

/** Phones: the four main places along the bottom, and "More" for the rest and the profile. */
function MobileBar({ user, isAdmin, logout, onEdit }: { user: ShellUser; isAdmin: boolean; logout: () => Promise<void>; onEdit: () => void }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const drawerLinks = isAdmin ? [...DRAWER_LINKS, { href: "/admin", label: "Admin", icon: Settings }] : DRAWER_LINKS;
  const inDrawer = drawerLinks.some((link) => pathname.startsWith(link.href));

  useEffect(() => setOpen(false), [pathname]);

  return (
    <>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {BAR_LINKS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn("flex h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium", active ? "text-primary-text" : "text-muted-foreground")}>
              <Icon className="size-5" strokeWidth={1.9} />
              {label}
            </Link>
          );
        })}
        <button type="button" onClick={() => setOpen(true)} aria-expanded={open} className={cn("flex h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium", inDrawer ? "text-primary-text" : "text-muted-foreground")}>
          <MoreHorizontal className="size-5" strokeWidth={1.9} />
          More
        </button>
      </nav>

      {open ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-label="More">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-foreground/30" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl bg-surface p-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
            <div className="mb-1 flex items-center justify-between px-2">
              <span className="text-[17px] font-bold">More</span>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2">
                <X className="size-5" strokeWidth={1.75} />
              </button>
            </div>
            {user.brandName ? <p className="px-3 pb-2 text-xs text-muted-foreground">{user.brandName}</p> : <div className="px-3 pb-2"><BrandSwitcher current={user.viewBrand} /></div>}
            <div className="grid">
              {drawerLinks.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} className={MENU_ITEM} onClick={() => setOpen(false)}>
                  <Icon className="size-4 text-muted-foreground" strokeWidth={1.75} />
                  {label}
                </Link>
              ))}
            </div>
            <div className="my-2 border-t" />
            <ProfileItems user={user} logout={logout} onEdit={() => { setOpen(false); onEdit(); }} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
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
