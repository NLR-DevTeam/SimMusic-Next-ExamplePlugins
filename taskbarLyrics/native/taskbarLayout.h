#ifndef SIMMUSIC_TASKBAR_LAYOUT_H
#define SIMMUSIC_TASKBAR_LAYOUT_H
#define LAYOUT_CLASS L"SimMusicTaskbarLayout113"
#define LAYOUT_DLL L"taskbarLayout-1.1.3.dll"
#define LAYOUT_READY L"SimMusicLayoutReady"
#define LAYOUT_OWNER L"SimMusicLayoutOwner"
typedef struct TaskbarSlotRequest { DWORD owner; double width, right; } TaskbarSlotRequest;
static const CLSID layoutClassId = {0x251f493d,0x9de1,0x49ec,{0xa4,0x8c,0x16,0x6a,0x25,0xd3,0xb2,0x94}};
#endif
