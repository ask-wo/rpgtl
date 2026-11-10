import { Link, Outlet } from "@tanstack/react-router";
import { LanguagesIcon, SettingsIcon } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "~/components/ui/sidebar";
import { TooltipProvider } from "~/components/ui/tooltip";
import { GamesNav } from "../games/GamesNav.tsx";
import { OpenGameButton } from "../games/OpenGameButton.tsx";

/** The sidebar on every page, and the page the address names beside it. */
export function AppShell() {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader className="gap-3 border-b">
            <div className="flex items-center gap-2 px-2 pt-1 text-sm font-semibold tracking-tight">
              <LanguagesIcon className="size-4" />
              RPGTL
            </div>
            <OpenGameButton />
          </SidebarHeader>
          <SidebarContent>
            <GamesNav />
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link to="/settings" activeProps={{ "data-active": "" }} />}
                >
                  <SettingsIcon />
                  Settings
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset>
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
