// Windows 11: reserve room in the task buttons' XAML layout. The taskbar HWND,
// background and notification area retain their original bounds. No hooks or
// polling of files: XAML Diagnostics supplies the element, then a message-only
// controller owns the reservation and restores it even if the lyrics process dies.
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <ocidl.h>
#include <initguid.h>
#include <xamlom.h>
#include <cwchar>
#include <new>
#include "taskbarLayout.h"

static HMODULE module;
static const IID frameworkId = {0xa391d09b,0x4a99,0x4b7c,{0x9d,0x8d,0x6f,0xa5,0xd0,0x1f,0x6f,0xbf}};
static const IID uiElementId = {0x676d0be9,0xb65c,0x41c6,{0xba,0x40,0x58,0xcf,0x87,0xf2,0x01,0xc1}};
struct Thickness { double left, top, right, bottom; };
struct Point { float x, y; };
// Stable Windows.UI.Xaml ABI slots from the Windows SDK IFrameworkElement,
// IUIElement and IGeneralTransform declarations. Keep their WinRT struct ABI.
template<class Function> static Function method(IUnknown *object, int slot) {
    return reinterpret_cast<Function>((*reinterpret_cast<void ***>(object))[slot]);
}
static HRESULT getNumber(IUnknown *object, int slot, double *value) {
    return method<HRESULT(STDMETHODCALLTYPE *)(IUnknown *, double *)>(object, slot)(object, value);
}
static HRESULT getMargin(IUnknown *object, Thickness *value) {
    return method<HRESULT(STDMETHODCALLTYPE *)(IUnknown *, Thickness *)>(object, 31)(object, value);
}
static HRESULT putMargin(IUnknown *object, Thickness value) {
    return method<HRESULT(STDMETHODCALLTYPE *)(IUnknown *, Thickness)>(object, 32)(object, value);
}
static bool equal(Thickness a, Thickness b) {
    return a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom;
}
static HRESULT originOf(IUnknown *ui, Point *point) {
    IUnknown *transform = nullptr;
    HRESULT hr = method<HRESULT(STDMETHODCALLTYPE *)(IUnknown *, IUnknown *, IUnknown **)>(ui, 98)(ui, nullptr, &transform);
    if (SUCCEEDED(hr)) {
        hr = method<HRESULT(STDMETHODCALLTYPE *)(IUnknown *, Point, Point *)>(transform, 7)(transform, {0, 0}, point);
        transform->Release();
    }
    return hr;
}

class Layout final : public IObjectWithSite, public IVisualTreeServiceCallback2 {
    LONG references = 1;
    IXamlDiagnostics *diagnostics = nullptr;
    IVisualTreeService *tree = nullptr;
    IUnknown *framework = nullptr, *ui = nullptr;
    InstanceHandle target = 0;
    HWND controller = nullptr;
    HANDLE owner = nullptr;
    TaskbarSlotRequest request{};
    Thickness originalMargin{}, appliedMargin{};
    bool ownsMargin = false, applying = false;

    void restore() {
        if (framework) {
            Thickness current{};
            if (ownsMargin && SUCCEEDED(getMargin(framework, &current)) && equal(current, appliedMargin)) putMargin(framework, originalMargin);
            if (ui) method<HRESULT(STDMETHODCALLTYPE *)(IUnknown *)>(ui, 101)(ui);
        }
        ownsMargin = false;
        if (controller) SetPropW(controller, LAYOUT_READY, nullptr);
    }
    void clearOwner() {
        restore();
        if (owner) CloseHandle(owner);
        owner = nullptr; request = {};
        if (controller) { KillTimer(controller, 1); RemovePropW(controller, LAYOUT_OWNER); }
    }
    void apply() {
        if (applying || !framework || !ui || !owner) return;
        if (WaitForSingleObject(owner, 0) != WAIT_TIMEOUT) { clearOwner(); return; }
        applying = true;
        Thickness current{};
        Point origin{};
        HRESULT hr = getMargin(framework, &current);
        if (SUCCEEDED(hr)) hr = originOf(ui, &origin);
        if (SUCCEEDED(hr)) {
            if (!ownsMargin || !equal(current, appliedMargin)) originalMargin = current;
            Thickness wanted = originalMargin;
            wanted.right += request.width;
            bool changed = !equal(current, wanted);
            if (!equal(current, wanted)) hr = putMargin(framework, wanted);
            if (SUCCEEDED(hr)) { appliedMargin = wanted; ownsMargin = true; }
            if (SUCCEEDED(hr) && changed) hr = method<HRESULT(STDMETHODCALLTYPE *)(IUnknown *)>(ui, 101)(ui);
            double actualWidth = 0;
            if (SUCCEEDED(hr)) hr = getNumber(framework, 13, &actualWidth);
            if (SUCCEEDED(hr)) hr = originOf(ui, &origin);
            // The taskbar repeater's measured width includes the space Explorer
            // allocates for the notification area. Its task buttons end before it.
            HWND taskbar = FindWindowW(L"Shell_TrayWnd", nullptr);
            HWND notify = FindWindowExW(taskbar, nullptr, L"TrayNotifyWnd", nullptr);
            RECT tray{};
            double trayWidth = notify && GetWindowRect(notify, &tray) ? (tray.right - tray.left) * 96.0 / GetDpiForWindow(taskbar) : 0;
            double buttonsRight = origin.x + actualWidth - trayWidth;
            SetPropW(controller, LAYOUT_READY, reinterpret_cast<HANDLE>(SUCCEEDED(hr) && actualWidth > 0 && buttonsRight <= request.right + .5));
            WCHAR status[160];
            swprintf(status, 160, L"hr=%08lx buttonsRight=%.2f limit=%.2f margin=%.2f", (unsigned long)hr, buttonsRight, request.right, wanted.right);
            SetWindowTextW(controller, status);
        }
        applying = false;
    }
    static LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
        auto self = reinterpret_cast<Layout *>(GetWindowLongPtrW(window, GWLP_USERDATA));
        if (message == WM_NCCREATE) {
            self = static_cast<Layout *>(reinterpret_cast<CREATESTRUCTW *>(lParam)->lpCreateParams);
            SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
        }
        if (!self) return DefWindowProcW(window, message, wParam, lParam);
        if (message == WM_COPYDATA) {
            auto data = reinterpret_cast<COPYDATASTRUCT *>(lParam);
            if (data->cbData != sizeof(TaskbarSlotRequest)) return FALSE;
            TaskbarSlotRequest next = *static_cast<TaskbarSlotRequest *>(data->lpData);
            if (!next.owner || next.width <= 0) { self->clearOwner(); return TRUE; }
            if (!self->owner || next.owner != self->request.owner) {
                HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, next.owner);
                if (!process) return FALSE;
                if (self->owner) CloseHandle(self->owner);
                self->owner = process;
            }
            self->request = next;
            SetPropW(window, LAYOUT_OWNER, reinterpret_cast<HANDLE>(static_cast<ULONG_PTR>(next.owner)));
            SetTimer(window, 1, 500, nullptr);
            self->apply();
            return TRUE;
        }
        if (message == WM_TIMER || message == WM_APP + 1) { self->apply(); return 0; }
        return DefWindowProcW(window, message, wParam, lParam);
    }
    static DWORD WINAPI advise(void *argument) {
        auto self = static_cast<Layout *>(argument);
        self->tree->AdviseVisualTreeChange(self);
        self->Release();
        return 0;
    }
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void **result) override {
        *result = nullptr;
        if (id == IID_IUnknown || id == IID_IObjectWithSite) *result = static_cast<IObjectWithSite *>(this);
        else if (id == IID_IVisualTreeServiceCallback || id == IID_IVisualTreeServiceCallback2) *result = static_cast<IVisualTreeServiceCallback2 *>(this);
        else return E_NOINTERFACE;
        AddRef(); return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references); }
    ULONG STDMETHODCALLTYPE Release() override { ULONG left = InterlockedDecrement(&references); if (!left) delete this; return left; }
    HRESULT STDMETHODCALLTYPE SetSite(IUnknown *site) override {
        if (!site || tree) return S_OK;
        HRESULT hr = site->QueryInterface(IID_IXamlDiagnostics, reinterpret_cast<void **>(&diagnostics));
        if (SUCCEEDED(hr)) hr = site->QueryInterface(IID_IVisualTreeService, reinterpret_cast<void **>(&tree));
        if (SUCCEEDED(hr)) {
            AddRef();
            HANDLE thread = CreateThread(nullptr, 0, advise, this, 0, nullptr);
            if (thread) CloseHandle(thread); else { Release(); return HRESULT_FROM_WIN32(GetLastError()); }
        }
        return hr;
    }
    HRESULT STDMETHODCALLTYPE GetSite(REFIID id, void **result) override { return diagnostics ? diagnostics->QueryInterface(id, result) : E_FAIL; }
    HRESULT STDMETHODCALLTYPE OnVisualTreeChange(ParentChildRelation, VisualElement element, VisualMutationType mutation) override {
        if (mutation == Add && element.Name && !wcscmp(element.Name, L"TaskbarFrameRepeater") &&
            GetCurrentThreadId() == GetWindowThreadProcessId(FindWindowW(L"Shell_TrayWnd", nullptr), nullptr)) {
            if (target != element.Handle) {
                clearOwner();
                if (framework) framework->Release();
                if (ui) ui->Release();
                framework = ui = nullptr;
                IInspectable *object = nullptr;
                if (SUCCEEDED(diagnostics->GetIInspectableFromHandle(element.Handle, &object))) {
                    object->QueryInterface(frameworkId, reinterpret_cast<void **>(&framework));
                    object->QueryInterface(uiElementId, reinterpret_cast<void **>(&ui));
                    object->Release();
                }
                target = element.Handle;
            }
            if (!controller && framework && ui) {
                WNDCLASSW type{}; type.lpfnWndProc = windowProc; type.hInstance = module; type.lpszClassName = LAYOUT_CLASS;
                RegisterClassW(&type);
                controller = CreateWindowExW(0, LAYOUT_CLASS, L"ready", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, module, this);
            }
        } else if (mutation == Remove && element.Handle == target) {
            clearOwner(); target = 0;
            if (framework) { framework->Release(); framework = nullptr; }
            if (ui) { ui->Release(); ui = nullptr; }
        }
        if (mutation == Add) {
            SysFreeString(element.Name); SysFreeString(element.Type);
            SysFreeString(element.SrcInfo.FileName); SysFreeString(element.SrcInfo.Hash);
        }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE OnElementStateChanged(InstanceHandle, VisualElementState, LPCWSTR) override { return S_OK; }
};
class Factory final : public IClassFactory {
    LONG references = 1;
public:
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void **result) override {
        if (id != IID_IUnknown && id != IID_IClassFactory) { *result = nullptr; return E_NOINTERFACE; }
        *result = static_cast<IClassFactory *>(this); AddRef(); return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references); }
    ULONG STDMETHODCALLTYPE Release() override { ULONG left = InterlockedDecrement(&references); if (!left) delete this; return left; }
    HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown *outer, REFIID id, void **result) override {
        if (outer) return CLASS_E_NOAGGREGATION;
        auto object = new (std::nothrow) Layout;
        if (!object) return E_OUTOFMEMORY;
        HRESULT hr = object->QueryInterface(id, result); object->Release(); return hr;
    }
    HRESULT STDMETHODCALLTYPE LockServer(BOOL) override { return S_OK; }
};
extern "C" __declspec(dllexport) HRESULT WINAPI DllGetClassObject(REFCLSID clsid, REFIID id, void **result) {
    if (clsid != layoutClassId) return CLASS_E_CLASSNOTAVAILABLE;
    auto factory = new (std::nothrow) Factory;
    if (!factory) return E_OUTOFMEMORY;
    HRESULT hr = factory->QueryInterface(id, result); factory->Release(); return hr;
}
extern "C" __declspec(dllexport) HRESULT WINAPI DllCanUnloadNow() { return S_FALSE; }
BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) { module = instance; DisableThreadLibraryCalls(instance); }
    return TRUE;
}
