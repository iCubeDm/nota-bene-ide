// The SDK's UI primitives for plugins (issue 511), kept out of @/sdk so the runtime API stays readable.
export { Button } from '../components/ui/button.tsx';
export { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/tooltip.tsx';
export { Popover, PopoverAnchor, PopoverTrigger, PopoverContent } from '../components/ui/popover.tsx';
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  MENU_ROW,
} from '../components/ui/dropdown-menu.tsx';
export { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '../components/ui/context-menu.tsx';
export { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.tsx';
export { ConfirmDialog } from '../components/ConfirmDialog.tsx';
export { PermissionCard } from '../components/PermissionCard.tsx';
export { ViewPane } from '../components/ViewPane.tsx';
export { ToolButton } from '../components/ToolButton.tsx';
export { PanelResizer, usePanelWidth } from '../shell/PanelResizer.tsx';
export { SettingsRow, SettingsFail } from '../components/SettingsRow.tsx';
export { AgentIcon, ICONS, Svg, ArchiveIcon } from '../components/icons.tsx';
export { focusTab } from '../tabs/focus.ts';
export { FileIcon } from '../components/FileIcon.tsx';
export { PlayIcon, PauseIcon, ReplayIcon, VolumeOffIcon, VolumeLowIcon, VolumeHighIcon, PencilIcon, PipIcon, EnterFullscreenIcon, ExitFullscreenIcon, EdgeBackIcon, EdgeForwardIcon, FrameBackIcon, FrameForwardIcon } from '../components/playerIcons.tsx';
export { MessageInput, MicButton, SendIcon, PlaneIcon } from '../components/MessageInput.tsx';
export { Slots } from '../shell/Slots.tsx';
export { Markdown } from '../components/markdown/Markdown.tsx';
