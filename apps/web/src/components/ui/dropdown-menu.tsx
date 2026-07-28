"use client";

import * as Menu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

interface DropdownItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
}

interface DropdownMenuProps {
  trigger: ReactNode;
  items: DropdownItem[];
  align?: "start" | "end";
}

export function DropdownMenu({ trigger, items, align = "end" }: DropdownMenuProps) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>{trigger}</Menu.Trigger>
      <Menu.Portal>
        {/*
          Radix computes this element's own inline `transform` for popper
          positioning. A CSS animation on the same element overrides that
          `transform` for the animation's duration, so the menu would open
          unpositioned before snapping to its real spot — the animation
          lives on the inner div instead, which has no positioning role.
        */}
        <Menu.Content align={align} sideOffset={6} className="z-[var(--z-dropdown)]">
          <div className="min-w-[180px] rounded-md border border-[var(--border)] bg-[var(--bg-primary)] py-1.5 shadow-xl animate-scale-in">
            {items.map((item) => (
              <Menu.Item
                key={item.label}
                onSelect={item.onSelect}
                className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs font-medium outline-none transition-colors data-[highlighted]:bg-[var(--accent)] data-[highlighted]:text-white ${
                  item.destructive ? "text-[var(--danger)]" : "text-[var(--text-secondary)]"
                }`}
              >
                {item.icon}
                {item.label}
              </Menu.Item>
            ))}
          </div>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
