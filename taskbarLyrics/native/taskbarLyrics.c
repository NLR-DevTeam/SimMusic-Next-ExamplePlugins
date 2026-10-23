// 任务栏歌词的原生部分：一个嵌在系统任务栏（Shell_TrayWnd）里的分层子窗口。
// 平时显示当前歌词；鼠标移入时换成播放控制（播放模式、上一首、播放 / 暂停、下一首、音量、打开主窗口）。
//
// 它不认识播放器：扩展脚本经标准输入逐行告诉它显示什么，它把用户的操作逐行写到标准输出。
//   输入（UTF-8，字段以 Tab 分隔）
//     line   <已唱毫秒> <整句毫秒> <主行> <副行>   主行为空时隐藏；整句毫秒为 0 时过长的文字以省略号截断
//     state  <是否播放> <播放模式 0-2> <音量 0-100> <倍速×100>
//     opt    <宽度（96 DPI 下的像素）> <对齐 0 左 1 中 2 右>
//     cover  <图片路径>                               当前曲目的封面，画在歌词左侧；路径为空时不画
//     dump   <PNG 路径> <高度?>                       把当前画面写成图片，供开发时查看；可指定按另一个高度来画
//     peek   <是否音量滑块> <高亮的按钮>              直接画出悬停时的画面，供开发时查看
//   输出
//     toggle / previous / next / mode / volume <0-100> / show（打开主窗口并放到前台）/ menu（右键：歌曲菜单）
// 标准输入结束（扩展停用、主程序退出）时退出。
#define _WIN32_WINNT 0x0A00
#define WINVER 0x0A00
#include <windows.h>
#include <windowsx.h>
#include <objidl.h>
#include <gdiplus.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include "taskbarLayout.h"

#define WM_INPUT_LINE (WM_APP + 1)
#define WM_OUTPUT_LINE (WM_APP + 2)
#define WM_INPUT_END (WM_APP + 3)
#define TEXT_MAX 1024

static HWND taskbar, window, inbox; // inbox：只收消息的窗口，读线程把输入交到这里
static HDC memoryDC;
static HBITMAP dib;
static DWORD *bits;
static int width, height, shown;
static double scale = 1;
static DWORD writerThread;

static WCHAR mainText[TEXT_MAX], subText[TEXT_MAX], fontName[LF_FACESIZE] = L"Microsoft YaHei UI";
static double lineElapsed, lineTotal;   // 毫秒；lineElapsed 是 lineTick 时刻已唱的时长
static ULONGLONG lineTick;
static int playing, mode, volume = 80, rate = 100;
static int optWidth = 280, optAlign;
static int hover, volumeMode, hoverButton = -1, pressedButton = -1, dragging, tracking, animating, light;
static ULONGLONG volumeTouched;

static GpFontFamily *textFamily, *iconFamily;
static GpBitmap *cover, *coverScaled; // 封面读进内存后的副本，以及按当前尺寸缩好的一份
static int coverSize;
static HWND layoutService;
static LONG layoutStarting;
static DWORD layoutExplorer;
static TaskbarSlotRequest lastSlot;

static DWORD WINAPI connectLayout(void *argument) {
    DWORD process = (DWORD)(ULONG_PTR)argument;
    HMODULE xaml = LoadLibraryExW(L"Windows.UI.Xaml.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
    typedef HRESULT (WINAPI *InitializeDiagnostics)(PCWSTR, DWORD, PCWSTR, PCWSTR, CLSID, PCWSTR);
    InitializeDiagnostics initialize = xaml ? (InitializeDiagnostics)GetProcAddress(xaml, "InitializeXamlDiagnosticsEx") : NULL;
    WCHAR dll[MAX_PATH];
    GetModuleFileNameW(NULL, dll, MAX_PATH);
    WCHAR *name = wcsrchr(dll, L'\\');
    if (name && initialize) {
        wcscpy(name + 1, LAYOUT_DLL);
        // XAML Diagnostics retains its module in Explorer. Load a versioned copy
        // from the system temp directory so extension updates/removal never lock
        // the user's editable plugin files. Copy once for this exact build.
        WIN32_FILE_ATTRIBUTE_DATA image;
        WCHAR temporary[MAX_PATH], directory[MAX_PATH], runtime[MAX_PATH];
        if (!GetFileAttributesExW(dll, GetFileExInfoStandard, &image) || !GetTempPathW(MAX_PATH, temporary)) goto done;
        if (swprintf(directory, MAX_PATH, L"%lsSimMusicNext", temporary) < 0) goto done;
        CreateDirectoryW(directory, NULL);
        if (swprintf(directory, MAX_PATH, L"%lsSimMusicNext\\taskbar-layout", temporary) < 0) goto done;
        CreateDirectoryW(directory, NULL);
        if (swprintf(runtime, MAX_PATH, L"%ls\\%ls-%08lx%08lx-%08lx.dll", directory, LAYOUT_DLL,
            image.ftLastWriteTime.dwHighDateTime, image.ftLastWriteTime.dwLowDateTime, image.nFileSizeLow) < 0) goto done;
        if (!CopyFileW(dll, runtime, TRUE) && GetLastError() != ERROR_FILE_EXISTS) goto done;
        for (int i = 1; i <= 60; i++) {
            WCHAR connection[64]; swprintf(connection, 64, L"VisualDiagConnection%d", i);
            HRESULT hr = initialize(connection, process, NULL, runtime, layoutClassId, NULL);
            if (SUCCEEDED(hr)) break;
            if (hr != HRESULT_FROM_WIN32(ERROR_NOT_FOUND)) break;
        }
    }
done:
    if (xaml) FreeLibrary(xaml);
    InterlockedExchange(&layoutStarting, 0);
    return 0;
}
static int reserveTaskbar(int x, int w, double dpiScale) {
    DWORD process = 0;
    GetWindowThreadProcessId(taskbar, &process);
    if (!layoutService || !IsWindow(layoutService)) layoutService = FindWindowExW(HWND_MESSAGE, NULL, LAYOUT_CLASS, NULL);
    if (!layoutService) {
        if (layoutExplorer != process && !InterlockedExchange(&layoutStarting, 1)) {
            layoutExplorer = process;
            HANDLE thread = CreateThread(NULL, 0, connectLayout, (void *)(ULONG_PTR)process, 0, NULL);
            if (thread) CloseHandle(thread); else InterlockedExchange(&layoutStarting, 0);
        }
        return 0;
    }
    TaskbarSlotRequest slot = { GetCurrentProcessId(), (double)w / dpiScale + 4, (double)x / dpiScale };
    if (lastSlot.owner != slot.owner || lastSlot.width != slot.width || lastSlot.right != slot.right ||
        (DWORD)(ULONG_PTR)GetPropW(layoutService, LAYOUT_OWNER) != slot.owner) {
        COPYDATASTRUCT data = {0, sizeof(slot), &slot}; DWORD_PTR result = 0;
        if (!SendMessageTimeoutW(layoutService, WM_COPYDATA, (WPARAM)window, (LPARAM)&data, SMTO_ABORTIFHUNG, 200, &result) || !result) return 0;
        lastSlot = slot;
    }
    return GetPropW(layoutService, LAYOUT_READY) != NULL;
}
static void releaseTaskbar(void) {
    if (!layoutService || !IsWindow(layoutService) || (DWORD)(ULONG_PTR)GetPropW(layoutService, LAYOUT_OWNER) != GetCurrentProcessId()) return;
    TaskbarSlotRequest slot = {0}; COPYDATASTRUCT data = {0, sizeof(slot), &slot}; DWORD_PTR result;
    SendMessageTimeoutW(layoutService, WM_COPYDATA, (WPARAM)window, (LPARAM)&data, SMTO_ABORTIFHUNG, 200, &result);
    lastSlot = slot;
}

// ---------- 输出：由单独的线程写，管道写不动时不会拖住与任务栏相连的界面线程 ----------
static DWORD WINAPI writer(LPVOID ready) {
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    MSG message;
    PeekMessageW(&message, NULL, WM_USER, WM_USER, PM_NOREMOVE);
    SetEvent((HANDLE)ready);
    while (GetMessageW(&message, NULL, 0, 0) > 0) {
        if (message.message != WM_OUTPUT_LINE) continue;
        char *text = (char *)message.lParam;
        DWORD written;
        WriteFile(out, text, (DWORD)strlen(text), &written, NULL);
        free(text);
    }
    return 0;
}
static void emit(const char *format, int value) {
    char *text = malloc(48);
    snprintf(text, 48, format, value);
    if (!PostThreadMessageW(writerThread, WM_OUTPUT_LINE, 0, (LPARAM)text)) free(text);
}

// ---------- 输入：读线程把每一行交给界面线程 ----------
static DWORD WINAPI reader(LPVOID unused) {
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    static char buffer[16384];
    int used = 0;
    for (;;) {
        DWORD got = 0;
        if (!ReadFile(in, buffer + used, sizeof(buffer) - used - 1, &got, NULL) || !got) break;
        used += got;
        for (;;) {
            char *end = memchr(buffer, '\n', used);
            if (!end) { if (used >= (int)sizeof(buffer) - 1) used = 0; break; }
            int length = (int)(end - buffer);
            int count = MultiByteToWideChar(CP_UTF8, 0, buffer, length, NULL, 0);
            WCHAR *line = malloc((count + 1) * sizeof(WCHAR));
            MultiByteToWideChar(CP_UTF8, 0, buffer, length, line, count);
            line[count] = 0;
            if (count && line[count - 1] == L'\r') line[count - 1] = 0;
            if (!PostMessageW(inbox, WM_INPUT_LINE, 0, (LPARAM)line)) free(line);
            used -= length + 1;
            memmove(buffer, end + 1, used);
        }
    }
    PostMessageW(inbox, WM_INPUT_END, 0, 0);
    return 0;
}

// ---------- 绘制 ----------
static ARGB ink(int alpha) { return ((ARGB)alpha << 24) | (light ? 0x000000 : 0xffffff); }
static double elapsedNow(void) {
    return lineElapsed + (playing ? (double)(GetTickCount64() - lineTick) * rate / 100 : 0);
}
static void fillRoundWith(GpGraphics *g, double x, double y, double w, double h, double radius, GpBrush *brush) {
    GpPath *path;
    radius = min(radius, min(w, h) / 2);
    float d = (float)(radius * 2);
    GdipCreatePath(FillModeAlternate, &path);
    GdipAddPathArc(path, (float)x, (float)y, d, d, 180, 90);
    GdipAddPathArc(path, (float)(x + w) - d, (float)y, d, d, 270, 90);
    GdipAddPathArc(path, (float)(x + w) - d, (float)(y + h) - d, d, d, 0, 90);
    GdipAddPathArc(path, (float)x, (float)(y + h) - d, d, d, 90, 90);
    GdipClosePathFigure(path);
    GdipFillPath(g, brush, path);
    GdipDeletePath(path);
}
static void fillRound(GpGraphics *g, double x, double y, double w, double h, double radius, ARGB color) {
    GpSolidFill *brush;
    GdipCreateSolidFill(color, &brush);
    fillRoundWith(g, x, y, w, h, radius, (GpBrush *)brush);
    GdipDeleteBrush((GpBrush *)brush);
}
// 封面：整个读进一张自己的位图（原文件随即放开，扩展可以覆盖它），裁成正方形。
static void loadCover(const WCHAR *path) {
    if (cover) { GdipDisposeImage((GpImage *)cover); cover = NULL; }
    if (coverScaled) { GdipDisposeImage((GpImage *)coverScaled); coverScaled = NULL; }
    GpBitmap *source; GpGraphics *g; UINT w = 0, h = 0;
    if (!path[0] || GdipCreateBitmapFromFile(path, &source) != Ok) return;
    GdipGetImageWidth((GpImage *)source, &w);
    GdipGetImageHeight((GpImage *)source, &h);
    if (w && h && GdipCreateBitmapFromScan0(160, 160, 0, PixelFormat32bppPARGB, NULL, &cover) == Ok) {
        UINT side = min(w, h);
        GdipGetImageGraphicsContext((GpImage *)cover, &g);
        GdipSetInterpolationMode(g, InterpolationModeHighQualityBicubic);
        GdipDrawImageRectRectI(g, (GpImage *)source, 0, 0, 160, 160, (w - side) / 2, (h - side) / 2, side, side, UnitPixel, NULL, NULL, NULL);
        GdipDeleteGraphics(g);
    }
    GdipDisposeImage((GpImage *)source);
}
// 小高度的任务栏（系统的“较小的任务栏按钮”）：放不下两行，只显示歌词；封面占满整个高度，贴边，不做圆角。
static int compact(void) { return height < 40 * scale; }
static int coverSide(void) { return compact() ? height : (int)min(32 * scale, height - 12 * scale); }
// 封面连同它到窗口边缘、到文字的间距一共占多宽；没有封面时只是文字到边缘的间距。
static double coverSpace(void) { return cover && coverSide() > 0 ? (compact() ? 0 : 8 * scale) + coverSide() + 8 * scale : 8 * scale; }
static void drawCover(GpGraphics *g) {
    if (!cover) return;
    int size = coverSide();
    if (size <= 0) return;
    if (!coverScaled || coverSize != size) {
        GpGraphics *sg;
        if (coverScaled) GdipDisposeImage((GpImage *)coverScaled);
        coverScaled = NULL;
        if (GdipCreateBitmapFromScan0(size, size, 0, PixelFormat32bppPARGB, NULL, &coverScaled) != Ok) return;
        GdipGetImageGraphicsContext((GpImage *)coverScaled, &sg);
        GdipSetInterpolationMode(sg, InterpolationModeHighQualityBicubic);
        GdipSetPixelOffsetMode(sg, PixelOffsetModeHalf);
        GdipDrawImageRectI(sg, (GpImage *)cover, 0, 0, size, size);
        GdipDeleteGraphics(sg);
        coverSize = size;
    }
    GpTexture *texture;
    // 靠右对齐时封面也在右边，文字排在它左侧。
    double edge = compact() ? 0 : 8 * scale;
    float x = (float)(int)(optAlign == 2 ? width - edge - size : edge), y = (float)((height - size) / 2);
    if (compact()) { GdipDrawImageRectI(g, (GpImage *)coverScaled, (int)x, 0, size, size); return; }
    if (GdipCreateTexture((GpImage *)coverScaled, WrapModeClamp, &texture) != Ok) return;
    GdipTranslateTextureTransform(texture, x, y, MatrixOrderAppend);
    fillRoundWith(g, x, y, size, size, 4 * scale, (GpBrush *)texture);
    GdipDeleteBrush((GpBrush *)texture);
}
static GpStringFormat *textFormat(void) {
    GpStringFormat *generic, *format;
    GdipStringFormatGetGenericTypographic(&generic);
    GdipCloneStringFormat(generic, &format);
    GdipSetStringFormatFlags(format, StringFormatFlagsNoWrap | StringFormatFlagsMeasureTrailingSpaces | StringFormatFlagsNoClip);
    return format;
}
static double measure(GpGraphics *g, const WCHAR *text, GpFont *font, GpStringFormat *format) {
    RectF layout = {0, 0, 0, 0}, bounds = {0};
    GdipMeasureString(g, text, -1, font, &layout, format, &bounds, NULL, NULL);
    return bounds.Width;
}
// 一行文字：放得下时按对齐方式摆放；放不下时，知道这一句多长就随演唱从头滚到尾，否则以省略号截断。
static void drawLine(GpGraphics *g, const WCHAR *text, double size, double top, double lineHeight, ARGB color, int scroll) {
    GpFont *font; GpSolidFill *brush;
    GpStringFormat *format = textFormat();
    double pad = optAlign == 2 ? 8 * scale : coverSpace(), room = width - pad - (optAlign == 2 ? coverSpace() : 8 * scale);
    if (GdipCreateFont(textFamily, (float)size, FontStyleRegular, UnitPixel, &font) != Ok) { GdipDeleteStringFormat(format); return; }
    GdipCreateSolidFill(color, &brush);
    double textWidth = measure(g, text, font, format);
    double y = top + (lineHeight - size * 1.32) / 2;
    if (room <= 0) {
    } else if (textWidth <= room) {
        RectF at = {(float)(pad + (optAlign == 1 ? (room - textWidth) / 2 : optAlign == 2 ? room - textWidth : 0)), (float)y, 0, 0};
        GdipDrawString(g, text, -1, font, &at, format, (GpBrush *)brush);
    } else if (!scroll) {
        RectF at = {(float)pad, (float)y, (float)room, (float)(size * 1.6)};
        GdipSetStringFormatFlags(format, StringFormatFlagsNoWrap);
        GdipSetStringFormatTrimming(format, StringTrimmingEllipsisCharacter);
        GdipDrawString(g, text, -1, font, &at, format, (GpBrush *)brush);
    } else {
        // 开头和结尾各停一会儿，中间匀速滚过。
        double overflow = textWidth - room, progress = (elapsedNow() / lineTotal - .12) / .7;
        double offset = overflow * max(0, min(1, progress));
        RectF at = {(float)(pad - offset), (float)y, 0, 0};
        GdipSetClipRectI(g, (int)pad, 0, (int)room, height, CombineModeReplace);
        GdipDrawString(g, text, -1, font, &at, format, (GpBrush *)brush);
        GdipResetClip(g);
        GdipFlush(g, FlushIntentionSync);
        // 还有文字的那一侧渐隐。
        int fade = (int)(14 * scale), from = max(0, (int)top), to = min(height, (int)(top + lineHeight));
        for (int column = 0; column < fade; column++) {
            int sides[2] = { offset > .5 ? (int)pad + column : -1, offset < overflow - .5 ? (int)(pad + room) - 1 - column : -1 };
            for (int side = 0; side < 2; side++) {
                if (sides[side] < 0 || sides[side] >= width) continue;
                for (int row = from; row < to; row++) {
                    DWORD *pixel = bits + row * width + sides[side];
                    DWORD a = (*pixel >> 24) * column / fade, r = ((*pixel >> 16) & 255) * column / fade, gr = ((*pixel >> 8) & 255) * column / fade, b = (*pixel & 255) * column / fade;
                    *pixel = (max(a, 1) << 24) | (r << 16) | (gr << 8) | b;
                }
            }
        }
        if (playing && progress < 1) animating = 1;
    }
    GdipDeleteBrush((GpBrush *)brush);
    GdipDeleteFont(font);
    GdipDeleteStringFormat(format);
}
static void drawLyrics(GpGraphics *g) {
    drawCover(g);
    double mainSize = 13 * scale, subSize = 11 * scale;
    int scroll = lineTotal > 0;
    if (subText[0] && !compact()) {
        double mainHeight = mainSize * 1.5, subHeight = subSize * 1.5, top = (height - mainHeight - subHeight) / 2;
        drawLine(g, mainText, mainSize, top, mainHeight, ink(255), scroll);
        drawLine(g, subText, subSize, top + mainHeight, subHeight, ink(170), 0);
    } else drawLine(g, mainText, mainSize, 0, height, ink(255), scroll);
}

// 悬停时的布局：六个按钮居中排开；点了音量按钮后是音量图标加一条滑块。
#define BUTTONS 6
static double buttonWidth(void) { return min(40 * scale, (double)width / BUTTONS); }
static RECT buttonRect(int index) {
    double w = buttonWidth(), h = min(32 * scale, height - 8 * scale);
    double left = volumeMode ? 6 * scale : (width - w * BUTTONS) / 2 + w * index;
    RECT rect = {(int)left, (int)((height - h) / 2), (int)(left + w), (int)((height + h) / 2)};
    return rect;
}
static void sliderRange(double *from, double *to) {
    *from = 6 * scale + buttonWidth() + 10 * scale;
    *to = max(*from + 1, width - 16 * scale);
}
static int buttonAt(int x, int y) {
    POINT point = {x, y};
    if (volumeMode) { RECT rect = buttonRect(4); return PtInRect(&rect, point) ? 4 : -1; }
    for (int i = 0; i < BUTTONS; i++) { RECT rect = buttonRect(i); if (PtInRect(&rect, point)) return i; }
    return -1;
}
static void drawIcon(GpGraphics *g, int index, WCHAR glyph) {
    RECT rect = buttonRect(index);
    if (hoverButton == index || pressedButton == index)
        fillRound(g, rect.left + scale, rect.top, rect.right - rect.left - 2 * scale, rect.bottom - rect.top, 4 * scale, ink(pressedButton == index ? 22 : 36));
    GpFont *font; GpSolidFill *brush; GpStringFormat *format;
    if (GdipCreateFont(iconFamily, (float)(16 * scale), FontStyleRegular, UnitPixel, &font) != Ok) return;
    GdipCreateStringFormat(0, LANG_NEUTRAL, &format);
    GdipSetStringFormatAlign(format, StringAlignmentCenter);
    GdipSetStringFormatLineAlign(format, StringAlignmentCenter);
    GdipSetStringFormatFlags(format, StringFormatFlagsNoWrap | StringFormatFlagsNoClip);
    GdipCreateSolidFill(ink(index == 2 ? 255 : 220), &brush);
    RectF at = {(float)rect.left, (float)rect.top, (float)(rect.right - rect.left), (float)(rect.bottom - rect.top)};
    WCHAR text[2] = {glyph, 0};
    GdipDrawString(g, text, 1, font, &at, format, (GpBrush *)brush);
    GdipDeleteBrush((GpBrush *)brush);
    GdipDeleteStringFormat(format);
    GdipDeleteFont(font);
}
static void drawControls(GpGraphics *g) {
    // Segoe Fluent Icons / Segoe MDL2 Assets：任务栏自己用的那套图标。
    static const WCHAR modes[] = {0xE8EE, 0xE8ED, 0xE8B1};
    WCHAR speaker = volume <= 0 ? 0xE74F : 0xE767;
    if (!volumeMode) {
        drawIcon(g, 0, modes[max(0, min(2, mode))]);
        drawIcon(g, 1, 0xE892);
        drawIcon(g, 2, playing ? 0xE769 : 0xE768);
        drawIcon(g, 3, 0xE893);
        drawIcon(g, 4, speaker);
        drawIcon(g, 5, 0xE8A7);
        return;
    }
    drawIcon(g, 4, speaker);
    double from, to, middle = height / 2.0, thick = 4 * scale, knob = 6 * scale;
    sliderRange(&from, &to);
    double at = from + (to - from) * volume / 100;
    fillRound(g, from, middle - thick / 2, to - from, thick, thick / 2, ink(60));
    if (at > from) fillRound(g, from, middle - thick / 2, at - from, thick, thick / 2, ink(235));
    fillRound(g, at - knob, middle - knob, knob * 2, knob * 2, knob, ink(255));
}

static const CLSID pngEncoder = {0x557cf406, 0x1a04, 0x11d3, {0x9a, 0x73, 0x00, 0x00, 0xf8, 0x1e, 0xf3, 0x2e}};
static const WCHAR *dumpPath;
static void render(void) {
    if (!window || !bits) return;
    // 整块留一点不透明度：完全透明的像素收不到鼠标消息，也就无从知道指针移了进来。
    for (int i = 0; i < width * height; i++) bits[i] = 0x01000000;
    GpBitmap *bitmap; GpGraphics *g;
    if (GdipCreateBitmapFromScan0(width, height, width * 4, PixelFormat32bppPARGB, (BYTE *)bits, &bitmap) != Ok) return;
    GdipGetImageGraphicsContext((GpImage *)bitmap, &g);
    GdipSetTextRenderingHint(g, TextRenderingHintAntiAliasGridFit);
    GdipSetSmoothingMode(g, SmoothingModeAntiAlias);
    int wasAnimating = animating;
    animating = 0;
    if (hover) drawControls(g); else drawLyrics(g);
    GdipDeleteGraphics(g);
    if (dumpPath) {
        // 垫上与任务栏相近的底色再保存，否则浅色文字在看图软件里什么也看不见。
        GpBitmap *picture; GpGraphics *pg;
        GdipCreateBitmapFromScan0(width, height, 0, PixelFormat32bppARGB, NULL, &picture);
        GdipGetImageGraphicsContext((GpImage *)picture, &pg);
        GdipGraphicsClear(pg, light ? 0xffeeeeee : 0xff202020);
        GdipDrawImageI(pg, (GpImage *)bitmap, 0, 0);
        GdipDeleteGraphics(pg);
        GdipSaveImageToFile((GpImage *)picture, dumpPath, &pngEncoder, NULL);
        GdipDisposeImage((GpImage *)picture);
        dumpPath = NULL;
    }
    GdipDisposeImage((GpImage *)bitmap);
    SIZE size = {width, height};
    POINT origin = {0, 0};
    BLENDFUNCTION blend = {AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
    UpdateLayeredWindow(window, NULL, NULL, &size, memoryDC, &origin, 0, &blend, ULW_ALPHA);
    if (animating != wasAnimating) { if (animating) SetTimer(window, 1, 16, NULL); else KillTimer(window, 1); }
}

// ---------- 窗口 ----------
static void setVolume(int value) {
    value = max(0, min(100, value));
    volumeTouched = GetTickCount64();
    if (value == volume) return;
    volume = value;
    emit("volume %d\n", volume);
    render();
}
static void volumeFromPoint(int x) {
    double from, to;
    sliderRange(&from, &to);
    setVolume((int)((x - from) * 100 / (to - from) + .5));
}
static void leave(void) {
    hover = volumeMode = dragging = 0;
    hoverButton = pressedButton = -1;
    render();
}
static void place(void);
static void handle(WCHAR *line);
static LRESULT CALLBACK windowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    int x = GET_X_LPARAM(lParam), y = GET_Y_LPARAM(lParam);
    if (hwnd == inbox) {
        // 输入与定时检查都是发给窗口的消息：发给线程的消息在系统自己的消息循环（移动窗口等）里会被丢掉。
        if (message == WM_INPUT_LINE) { handle((WCHAR *)lParam); free((void *)lParam); return 0; }
        if (message == WM_INPUT_END) { PostQuitMessage(0); return 0; }
        if (message == WM_TIMER) { place(); return 0; }
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }
    switch (message) {
    case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
    case WM_SETCURSOR: SetCursor(LoadCursorW(NULL, IDC_ARROW)); return TRUE;
    case WM_TIMER: render(); return 0;
    case WM_MOUSEMOVE: {
        if (!tracking) {
            TRACKMOUSEEVENT track = {sizeof(track), TME_LEAVE, hwnd, 0};
            tracking = TrackMouseEvent(&track);
        }
        int button = dragging ? -1 : buttonAt(x, y), changed = !hover || button != hoverButton;
        hover = 1;
        hoverButton = button;
        if (dragging) volumeFromPoint(x); else if (changed) render();
        return 0;
    }
    case WM_MOUSELEAVE:
        tracking = 0;
        if (!dragging && pressedButton < 0) leave();
        return 0;
    case WM_LBUTTONDOWN:
        SetCapture(hwnd);
        pressedButton = buttonAt(x, y);
        if (volumeMode && pressedButton < 0) { dragging = 1; volumeFromPoint(x); }
        render();
        return 0;
    case WM_LBUTTONUP: {
        int button = pressedButton, wasDragging = dragging;
        pressedButton = -1;
        dragging = 0;
        ReleaseCapture();
        if (!wasDragging && button >= 0 && button == buttonAt(x, y)) {
            if (button == 0) { mode = (mode + 1) % 3; emit("mode\n", 0); }
            if (button == 1) emit("previous\n", 0);
            if (button == 2) { playing = !playing; lineElapsed = elapsedNow(); lineTick = GetTickCount64(); emit("toggle\n", 0); }
            if (button == 3) emit("next\n", 0);
            if (button == 4) volumeMode = !volumeMode;
            // 点击落在这个进程上，决定前台窗口的权利也就在这里：让给主程序，它的窗口才能真正到前台。
            if (button == 5) { AllowSetForegroundWindow(ASFW_ANY); emit("show\n", 0); }
        }
        // 按着拖出窗口再松开：这时指针已经不在上面了。
        RECT client; POINT point = {x, y};
        GetClientRect(hwnd, &client);
        if (!PtInRect(&client, point)) leave(); else { hoverButton = buttonAt(x, y); render(); }
        return 0;
    }
    case WM_RBUTTONUP:
        // 右键：当前歌曲的菜单，由主程序在指针处弹出；菜单里的操作可能要把主窗口带到前台。
        AllowSetForegroundWindow(ASFW_ANY);
        emit("menu\n", 0);
        return 0;
    case WM_CAPTURECHANGED: pressedButton = -1; dragging = 0; return 0;
    case WM_MOUSEWHEEL: {
        int delta = GET_WHEEL_DELTA_WPARAM(wParam);
        if (delta) setVolume(volume + (delta > 0 ? 5 : -5));
        return 0;
    }
    case WM_DESTROY:
        // 资源管理器重启时任务栏连同这个子窗口一起消失；定时检查会在新的任务栏里重建。
        if (hwnd == window) { window = NULL; shown = tracking = animating = 0; hover = volumeMode = dragging = 0; hoverButton = pressedButton = -1; }
        return 0;
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
}
static void resizeSurface(int w, int h) {
    if (dib) { DeleteObject(dib); dib = NULL; bits = NULL; }
    if (!memoryDC) memoryDC = CreateCompatibleDC(NULL);
    BITMAPINFO info = {{sizeof(BITMAPINFOHEADER), w, -h, 1, 32, BI_RGB}};
    dib = CreateDIBSection(memoryDC, &info, DIB_RGB_COLORS, (void **)&bits, NULL, 0);
    if (dib) SelectObject(memoryDC, dib);
    width = w; height = h;
}
// 任务栏的位置、高度、缩放或主题变了就跟着变。每半秒检查一次。
static void place(void) {
    if (!taskbar || !IsWindow(taskbar)) { taskbar = FindWindowW(L"Shell_TrayWnd", NULL); window = NULL; }
    if (!taskbar) return;
    if (!window) {
        window = CreateWindowExW(WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, L"SimMusicTaskbarLyrics", L"", WS_CHILD,
            0, 0, 10, 10, taskbar, NULL, GetModuleHandleW(NULL), NULL);
        if (!window) return;
        width = height = 0;
    }
    DWORD lightValue = 0, valueSize = sizeof(lightValue);
    RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", L"SystemUsesLightTheme", RRF_RT_REG_DWORD, NULL, &lightValue, &valueSize);
    double newScale = GetDpiForWindow(taskbar) / 96.0;
    RECT bar, tray = {0};
    GetClientRect(taskbar, &bar);
    HWND notify = FindWindowExW(taskbar, NULL, L"TrayNotifyWnd", NULL);
    if (notify && GetWindowRect(notify, &tray)) MapWindowPoints(NULL, taskbar, (POINT *)&tray, 2);
    // 竖放的任务栏（旧系统）或找不到通知区域时，按常见的通知区域宽度估一个位置。
    int right = notify && tray.left > 0 && tray.left <= bar.right ? tray.left : bar.right - (int)(260 * newScale);
    int w = max((int)(60 * newScale), (int)(optWidth * newScale)), h = bar.bottom;
    int x = max(0, right - w - (int)(4 * newScale));
    w = min(w, right - x);
    int want = mainText[0] != 0;
    if (want) want = reserveTaskbar(x, w, newScale);
    else releaseTaskbar();
    static int lastX = -1;
    int changed = w != width || h != height || newScale != scale || (int)lightValue != light;
    scale = newScale; light = lightValue;
    if (w <= 0 || h <= 0) return;
    if (w != width || h != height) resizeSurface(w, h);
    if (changed || x != lastX || GetWindow(window, GW_HWNDPREV)) SetWindowPos(window, HWND_TOP, x, 0, w, h, SWP_NOACTIVATE);
    lastX = x;
    if (changed || want != shown) render();
    if (want != shown) { ShowWindow(window, want ? SW_SHOWNOACTIVATE : SW_HIDE); shown = want; }
}

static WCHAR *field(WCHAR **cursor) {
    WCHAR *start = *cursor, *tab = wcschr(start, L'\t');
    if (tab) { *tab = 0; *cursor = tab + 1; } else *cursor = start + wcslen(start);
    return start;
}
static void handle(WCHAR *line) {
    WCHAR *cursor = line, *name = field(&cursor);
    if (!wcscmp(name, L"line")) {
        double elapsed = _wtof(field(&cursor)), total = _wtof(field(&cursor));
        WCHAR *text = field(&cursor), *sub = field(&cursor);
        lineElapsed = elapsed; lineTotal = total; lineTick = GetTickCount64();
        if (wcscmp(text, mainText) || wcscmp(sub, subText)) {
            wcsncpy(mainText, text, TEXT_MAX - 1);
            wcsncpy(subText, sub, TEXT_MAX - 1);
        }
        place();
        render();
    } else if (!wcscmp(name, L"state")) {
        double before = elapsedNow();
        int nowPlaying = _wtoi(field(&cursor)), nowMode = _wtoi(field(&cursor)), nowVolume = _wtoi(field(&cursor)), nowRate = _wtoi(field(&cursor));
        lineElapsed = before; lineTick = GetTickCount64();
        playing = nowPlaying; mode = nowMode; rate = nowRate > 0 ? nowRate : 100;
        // 正在拖动音量或刚调过时，不让稍后到达的旧值把滑块拉回去。
        if (!dragging && GetTickCount64() - volumeTouched > 600) volume = max(0, min(100, nowVolume));
        render();
    } else if (!wcscmp(name, L"opt")) {
        // max / min 是宏，参数会被求值两次：先把字段取出来。
        int wanted = _wtoi(field(&cursor));
        optWidth = max(60, min(2000, wanted));
        optAlign = _wtoi(field(&cursor));
        place();
        render();
    } else if (!wcscmp(name, L"cover")) {
        loadCover(field(&cursor));
        render();
    } else if (!wcscmp(name, L"peek")) {
        // 开发时查看悬停画面：真实的悬停依赖指针确实在窗口上。
        hover = 1; volumeMode = _wtoi(field(&cursor)); hoverButton = _wtoi(field(&cursor));
        render();
    } else if (!wcscmp(name, L"dump")) {
        // 可选的第二个字段是高度（像素）：按这个高度画一次，用来查看别的任务栏高度下的画面。
        dumpPath = field(&cursor);
        int tall = _wtoi(field(&cursor)), real = height;
        if (tall > 0 && window) resizeSurface(width, tall);
        render();
        if (tall > 0 && window) { resizeSurface(width, real); render(); }
    }
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR arguments, int show) {
    GdiplusStartupInput input = {1, NULL, FALSE, FALSE};
    ULONG_PTR token;
    if (GdiplusStartup(&token, &input, NULL) != Ok) return 1;
    NONCLIENTMETRICSW metrics = {sizeof(metrics)};
    if (SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(metrics), &metrics, 0)) wcsncpy(fontName, metrics.lfMessageFont.lfFaceName, LF_FACESIZE - 1);
    // 雅黑中西文都有，优先于系统界面字体：后者在非中文系统上没有汉字，回退出来的字形与西文不协调。
    if (GdipCreateFontFamilyFromName(L"Microsoft YaHei UI", NULL, &textFamily) != Ok && GdipCreateFontFamilyFromName(fontName, NULL, &textFamily) != Ok) GdipGetGenericFontFamilySansSerif(&textFamily);
    if (GdipCreateFontFamilyFromName(L"Segoe Fluent Icons", NULL, &iconFamily) != Ok && GdipCreateFontFamilyFromName(L"Segoe MDL2 Assets", NULL, &iconFamily) != Ok) iconFamily = textFamily;
    WNDCLASSEXW windowClass = {.cbSize = sizeof(windowClass), .lpfnWndProc = windowProc, .hInstance = instance, .hCursor = LoadCursorW(NULL, IDC_ARROW), .lpszClassName = L"SimMusicTaskbarLyrics"};
    RegisterClassExW(&windowClass);
    MSG message;
    inbox = CreateWindowExW(0, L"SimMusicTaskbarLyrics", L"", 0, 0, 0, 0, 0, HWND_MESSAGE, NULL, instance, NULL);
    if (!inbox) return 1;
    HANDLE ready = CreateEventW(NULL, TRUE, FALSE, NULL);
    CreateThread(NULL, 0, writer, ready, 0, &writerThread);
    WaitForSingleObject(ready, 2000); // 写线程建好消息队列之后，才有操作可以交给它
    CreateThread(NULL, 0, reader, NULL, 0, NULL);
    SetTimer(inbox, 2, 500, NULL);
    place();
    while (GetMessageW(&message, NULL, 0, 0) > 0) DispatchMessageW(&message);
    releaseTaskbar();
    return 0;
}
