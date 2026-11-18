#![allow(non_snake_case, non_camel_case_types)]

use std::env;
use std::ffi::c_void;
use std::io::{self, Read, Write};
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};

type BOOL = i32;
type DWORD = u32;
type WORD = u16;
type LONG = i32;
type HANDLE = *mut c_void;
type HWND = *mut c_void;
type LPWSTR = *mut u16;
type LPCWSTR = *const u16;
type LPBYTE = *mut u8;

const FALSE: BOOL = 0;
const ERROR_NOT_FOUND: DWORD = 1168;
const ERROR_INSUFFICIENT_BUFFER: DWORD = 122;
const CRED_TYPE_GENERIC: DWORD = 1;
const CRED_PERSIST_LOCAL_MACHINE: DWORD = 2;
const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;
const AF_INET: DWORD = 2;
const AF_INET6: DWORD = 23;
const TCP_TABLE_OWNER_PID_LISTENER: DWORD = 3;
const FO_DELETE: u32 = 3;
const FOF_SILENT: u16 = 0x0004;
const FOF_NOCONFIRMATION: u16 = 0x0010;
const FOF_ALLOWUNDO: u16 = 0x0040;
const FOF_NOERRORUI: u16 = 0x0400;
const WTD_UI_NONE: DWORD = 2;
const WTD_REVOKE_NONE: DWORD = 0;
const WTD_CHOICE_FILE: DWORD = 1;
const WTD_STATEACTION_VERIFY: DWORD = 1;
const WTD_STATEACTION_CLOSE: DWORD = 2;

#[repr(C)]
struct CREDENTIALW {
    Flags: DWORD,
    Type: DWORD,
    TargetName: LPWSTR,
    Comment: LPWSTR,
    LastWritten: [DWORD; 2],
    CredentialBlobSize: DWORD,
    CredentialBlob: LPBYTE,
    Persist: DWORD,
    AttributeCount: DWORD,
    Attributes: *mut c_void,
    TargetAlias: LPWSTR,
    UserName: LPWSTR,
}

#[repr(C)]
struct SHFILEOPSTRUCTW {
    hwnd: HWND,
    wFunc: u32,
    pFrom: LPCWSTR,
    pTo: LPCWSTR,
    fFlags: u16,
    fAnyOperationsAborted: BOOL,
    hNameMappings: *mut c_void,
    lpszProgressTitle: LPCWSTR,
}

#[repr(C)]
struct UNICODE_STRING {
    Length: u16,
    MaximumLength: u16,
    Buffer: LPWSTR,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct MIB_TCPROW_OWNER_PID {
    dwState: DWORD,
    dwLocalAddr: DWORD,
    dwLocalPort: DWORD,
    dwRemoteAddr: DWORD,
    dwRemotePort: DWORD,
    dwOwningPid: DWORD,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct MIB_TCP6ROW_OWNER_PID {
    ucLocalAddr: [u8; 16],
    dwLocalScopeId: DWORD,
    dwLocalPort: DWORD,
    ucRemoteAddr: [u8; 16],
    dwRemoteScopeId: DWORD,
    dwRemotePort: DWORD,
    dwState: DWORD,
    dwOwningPid: DWORD,
}

#[repr(C)]
struct GUID {
    Data1: u32,
    Data2: u16,
    Data3: u16,
    Data4: [u8; 8],
}

#[repr(C)]
struct WINTRUST_FILE_INFO {
    cbStruct: DWORD,
    pcwszFilePath: LPCWSTR,
    hFile: HANDLE,
    pgKnownSubject: *mut GUID,
}

#[repr(C)]
struct WINTRUST_DATA {
    cbStruct: DWORD,
    pPolicyCallbackData: *mut c_void,
    pSIPClientData: *mut c_void,
    dwUIChoice: DWORD,
    fdwRevocationChecks: DWORD,
    dwUnionChoice: DWORD,
    pFile: *mut WINTRUST_FILE_INFO,
    dwStateAction: DWORD,
    hWVTStateData: HANDLE,
    pwszURLReference: LPWSTR,
    dwProvFlags: DWORD,
    dwUIContext: DWORD,
    pSignatureSettings: *mut c_void,
}

#[repr(C)]
struct VS_FIXEDFILEINFO {
    dwSignature: DWORD,
    dwStrucVersion: DWORD,
    dwFileVersionMS: DWORD,
    dwFileVersionLS: DWORD,
    dwProductVersionMS: DWORD,
    dwProductVersionLS: DWORD,
    dwFileFlagsMask: DWORD,
    dwFileFlags: DWORD,
    dwFileOS: DWORD,
    dwFileType: DWORD,
    dwFileSubtype: DWORD,
    dwFileDateMS: DWORD,
    dwFileDateLS: DWORD,
}

#[link(name = "advapi32")]
extern "system" {
    fn CredReadW(TargetName: LPCWSTR, Type: DWORD, Flags: DWORD, Credential: *mut *mut CREDENTIALW) -> BOOL;
    fn CredWriteW(Credential: *const CREDENTIALW, Flags: DWORD) -> BOOL;
    fn CredDeleteW(TargetName: LPCWSTR, Type: DWORD, Flags: DWORD) -> BOOL;
    fn CredFree(Buffer: *mut c_void);
}

#[link(name = "kernel32")]
extern "system" {
    fn GetLastError() -> DWORD;
    fn LoadLibraryA(lpLibFileName: *const u8) -> HANDLE;
    fn GetModuleHandleA(lpModuleName: *const u8) -> HANDLE;
    fn GetProcAddress(hModule: HANDLE, lpProcName: *const u8) -> *mut c_void;
    fn OpenProcess(dwDesiredAccess: DWORD, bInheritHandle: BOOL, dwProcessId: DWORD) -> HANDLE;
    fn CloseHandle(hObject: HANDLE) -> BOOL;
    fn QueryFullProcessImageNameW(hProcess: HANDLE, dwFlags: DWORD, lpExeName: LPWSTR, lpdwSize: *mut DWORD) -> BOOL;
    fn K32EnumProcesses(lpidProcess: *mut DWORD, cb: DWORD, lpcbNeeded: *mut DWORD) -> BOOL;
}

type NtQueryInfoFn = unsafe extern "system" fn(HANDLE, DWORD, *mut c_void, DWORD, *mut DWORD) -> LONG;

unsafe fn nt_query_information_process(
    process_handle: HANDLE,
    info_class: DWORD,
    info: *mut c_void,
    info_len: DWORD,
    ret_len: *mut DWORD,
) -> LONG {
    let h = GetModuleHandleA(b"ntdll.dll\0".as_ptr());
    if h.is_null() {
        return -1;
    }
    let p = GetProcAddress(h, b"NtQueryInformationProcess\0".as_ptr());
    if p.is_null() {
        return -1;
    }
    let f: NtQueryInfoFn = std::mem::transmute(p);
    f(process_handle, info_class, info, info_len, ret_len)
}

#[link(name = "iphlpapi")]
extern "system" {
    fn GetExtendedTcpTable(
        pTcpTable: *mut c_void,
        pdwSize: *mut DWORD,
        bOrder: BOOL,
        ulAf: DWORD,
        TableClass: DWORD,
        Reserved: DWORD,
    ) -> DWORD;
}

type SHFileOperationWFn = unsafe extern "system" fn(*mut SHFILEOPSTRUCTW) -> i32;

#[link(name = "version")]
extern "system" {
    fn GetFileVersionInfoSizeW(lptstrFilename: LPCWSTR, lpdwHandle: *mut DWORD) -> DWORD;
    fn GetFileVersionInfoW(lptstrFilename: LPCWSTR, dwHandle: DWORD, dwLen: DWORD, lpData: *mut c_void) -> BOOL;
    fn VerQueryValueW(pBlock: *const c_void, lpSubBlock: LPCWSTR, lplpBuffer: *mut *mut c_void, puLen: *mut u32) -> BOOL;
}

#[link(name = "wintrust")]
extern "system" {
    fn WinVerifyTrust(hwnd: HWND, pgActionID: *mut GUID, pWVTData: *mut c_void) -> LONG;
}

fn to_wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn query_process_exe(pid: DWORD) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as DWORD;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if ok != FALSE && size > 0 {
            Some(String::from_utf16_lossy(&buf[..size as usize]))
        } else {
            None
        }
    }
}

fn query_process_cmdline(pid: DWORD) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if handle.is_null() {
            return None;
        }
        let mut needed: DWORD = 0;
        let _ = nt_query_information_process(handle, 60, null_mut(), 0, &mut needed);
        let buf_len = if needed > size_of::<UNICODE_STRING>() as DWORD {
            needed as usize
        } else {
            4096
        };
        let mut buf = vec![0u8; buf_len];
        let status = nt_query_information_process(
            handle,
            60, // ProcessCommandLineInformation
            buf.as_mut_ptr() as *mut c_void,
            buf.len() as DWORD,
            &mut needed,
        );
        CloseHandle(handle);
        if status < 0 {
            return None;
        }
        let ustr = &*(buf.as_ptr() as *const UNICODE_STRING);
        if ustr.Buffer.is_null() || ustr.Length == 0 {
            return None;
        }
        let slice = std::slice::from_raw_parts(ustr.Buffer, (ustr.Length / 2) as usize);
        Some(String::from_utf16_lossy(slice))
    }
}

fn decode_port_be(raw: DWORD) -> u16 {
    u16::from_be((raw & 0xFFFF) as u16)
}

fn format_ipv4_endpoint(addr_le: DWORD, port_raw: DWORD) -> String {
    let bytes = addr_le.to_ne_bytes();
    let port = decode_port_be(port_raw);
    format!("{}.{}.{}.{}:{}", bytes[0], bytes[1], bytes[2], bytes[3], port)
}

fn format_ipv6_endpoint(addr: [u8; 16], port_raw: DWORD) -> String {
    let port = decode_port_be(port_raw);
    let ip = std::net::Ipv6Addr::from(addr);
    format!("[{}]:{}", ip, port)
}

struct ListenerRow {
    pid: DWORD,
    port: u16,
    name: String,
}

fn collect_tcp_listeners() -> Vec<ListenerRow> {
    let mut rows = Vec::new();
    unsafe {
        // IPv4
        let mut size: DWORD = 0;
        let mut rc = GetExtendedTcpTable(null_mut(), &mut size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
        if rc == ERROR_INSUFFICIENT_BUFFER && size > 0 {
            let mut buf = vec![0u8; size as usize];
            rc = GetExtendedTcpTable(buf.as_mut_ptr() as *mut c_void, &mut size, FALSE, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
            if rc == 0 && buf.len() >= 4 {
                let count = *(buf.as_ptr() as *const DWORD) as usize;
                let base = buf.as_ptr().add(4) as *const MIB_TCPROW_OWNER_PID;
                let max_fit = (buf.len() - 4) / size_of::<MIB_TCPROW_OWNER_PID>();
                for i in 0..count.min(max_fit) {
                    let row = *base.add(i);
                    rows.push(ListenerRow {
                        pid: row.dwOwningPid,
                        port: decode_port_be(row.dwLocalPort),
                        name: format_ipv4_endpoint(row.dwLocalAddr, row.dwLocalPort),
                    });
                }
            }
        }
        // IPv6
        let mut size6: DWORD = 0;
        let mut rc6 = GetExtendedTcpTable(null_mut(), &mut size6, FALSE, AF_INET6, TCP_TABLE_OWNER_PID_LISTENER, 0);
        if rc6 == ERROR_INSUFFICIENT_BUFFER && size6 > 0 {
            let mut buf = vec![0u8; size6 as usize];
            rc6 = GetExtendedTcpTable(buf.as_mut_ptr() as *mut c_void, &mut size6, FALSE, AF_INET6, TCP_TABLE_OWNER_PID_LISTENER, 0);
            if rc6 == 0 && buf.len() >= 4 {
                let count = *(buf.as_ptr() as *const DWORD) as usize;
                let base = buf.as_ptr().add(4) as *const MIB_TCP6ROW_OWNER_PID;
                let max_fit = (buf.len() - 4) / size_of::<MIB_TCP6ROW_OWNER_PID>();
                for i in 0..count.min(max_fit) {
                    let row = *base.add(i);
                    rows.push(ListenerRow {
                        pid: row.dwOwningPid,
                        port: decode_port_be(row.dwLocalPort),
                        name: format_ipv6_endpoint(row.ucLocalAddr, row.dwLocalPort),
                    });
                }
            }
        }
    }
    rows
}

fn cmd_cred(args: &[String]) -> i32 {
    if args.len() < 3 {
        eprintln!("usage: cred <read|write|delete> <service> <account>");
        return 2;
    }
    let op = args[0].as_str();
    let target = format!("{}:{}", args[1], args[2]);
    let target_w = to_wide(&target);
    let user_w = to_wide(&args[2]);

    match op {
        "read" => unsafe {
            let mut cred_ptr: *mut CREDENTIALW = null_mut();
            if CredReadW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred_ptr) == FALSE {
                let err = GetLastError();
                if err == ERROR_NOT_FOUND {
                    return 44;
                }
                eprintln!("CredReadW failed: {}", err);
                return 1;
            }
            let cred = &*cred_ptr;
            let bytes = if cred.CredentialBlob.is_null() || cred.CredentialBlobSize == 0 {
                &[][..]
            } else {
                std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
            };
            // Decode UTF-8 directly, or UTF-16LE if null bytes appear in even-length blob
            let text = if bytes.contains(&0) && bytes.len() % 2 == 0 {
                let u16s: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                String::from_utf16_lossy(&u16s)
            } else {
                String::from_utf8_lossy(bytes).into_owned()
            };
            CredFree(cred_ptr as *mut c_void);
            let _ = io::stdout().write_all(text.as_bytes());
            0
        },
        "write" => {
            let mut password = String::new();
            if io::stdin().read_to_string(&mut password).is_err() {
                return 1;
            }
            let mut bytes = password.into_bytes();
            unsafe {
                let cred = CREDENTIALW {
                    Flags: 0,
                    Type: CRED_TYPE_GENERIC,
                    TargetName: target_w.as_ptr() as LPWSTR,
                    Comment: null_mut(),
                    LastWritten: [0, 0],
                    CredentialBlobSize: bytes.len() as DWORD,
                    CredentialBlob: if bytes.is_empty() { null_mut() } else { bytes.as_mut_ptr() },
                    Persist: CRED_PERSIST_LOCAL_MACHINE,
                    AttributeCount: 0,
                    Attributes: null_mut(),
                    TargetAlias: null_mut(),
                    UserName: user_w.as_ptr() as LPWSTR,
                };
                if CredWriteW(&cred, 0) == FALSE {
                    eprintln!("CredWriteW failed: {}", GetLastError());
                    return 1;
                }
            }
            0
        }
        "delete" => unsafe {
            if CredDeleteW(target_w.as_ptr(), CRED_TYPE_GENERIC, 0) == FALSE {
                let err = GetLastError();
                if err == ERROR_NOT_FOUND {
                    return 44;
                }
                eprintln!("CredDeleteW failed: {}", err);
                return 1;
            }
            0
        },
        _ => {
            eprintln!("unknown cred op: {}", op);
            2
        }
    }
}

fn cmd_trash(args: &[String]) -> i32 {
    if args.is_empty() {
        eprintln!("usage: trash <path...>");
        return 2;
    }
    let mut wide_list: Vec<u16> = Vec::new();
    for raw in args {
        let abs = Path::new(raw);
        let resolved = if abs.is_absolute() {
            raw.replace('/', "\\")
        } else {
            match env::current_dir() {
                Ok(cwd) => cwd.join(abs).to_string_lossy().replace('/', "\\"),
                Err(_) => raw.replace('/', "\\"),
            }
        };
        wide_list.extend(std::ffi::OsStr::new(&resolved).encode_wide());
        wide_list.push(0);
    }
    wide_list.push(0); // double-null terminated

    unsafe {
        let h_shell = LoadLibraryA(b"shell32.dll\0".as_ptr());
        if h_shell.is_null() {
            eprintln!("LoadLibraryA(shell32.dll) failed: {}", GetLastError());
            return 1;
        }
        let p_fn = GetProcAddress(h_shell, b"SHFileOperationW\0".as_ptr());
        if p_fn.is_null() {
            eprintln!("GetProcAddress(SHFileOperationW) failed: {}", GetLastError());
            return 1;
        }
        let sh_file_op: SHFileOperationWFn = std::mem::transmute(p_fn);
        let mut op = SHFILEOPSTRUCTW {
            hwnd: null_mut(),
            wFunc: FO_DELETE,
            pFrom: wide_list.as_ptr(),
            pTo: null(),
            fFlags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT,
            fAnyOperationsAborted: FALSE,
            hNameMappings: null_mut(),
            lpszProgressTitle: null(),
        };
        let rc = sh_file_op(&mut op);
        if rc != 0 || op.fAnyOperationsAborted != FALSE {
            eprintln!("SHFileOperationW failed: rc={} aborted={}", rc, op.fAnyOperationsAborted);
            return 1;
        }
    }
    0
}

fn cmd_tcp_owners(args: &[String]) -> i32 {
    let port: u16 = match args.first().and_then(|s| s.parse().ok()) {
        Some(p) if p > 0 => p,
        _ => {
            eprintln!("usage: tcp-owners <port>");
            return 2;
        }
    };
    let rows = collect_tcp_listeners();
    let mut by_pid: std::collections::BTreeMap<DWORD, Vec<String>> = std::collections::BTreeMap::new();
    for row in rows {
        if row.port == port {
            by_pid.entry(row.pid).or_default().push(row.name);
        }
    }
    let mut out = String::from("[");
    let mut first = true;
    for (pid, names) in by_pid {
        if !first {
            out.push(',');
        }
        first = false;
        let exe = query_process_exe(pid).unwrap_or_default();
        let names_json = names.iter().map(|n| json_escape(n)).collect::<Vec<_>>().join(",");
        out.push_str(&format!("{{\"pid\":{},\"exe\":{},\"names\":[{}]}}", pid, json_escape(&exe), names_json));
    }
    out.push(']');
    println!("{}", out);
    0
}

fn cmd_ls_ports(args: &[String]) -> i32 {
    let pid: DWORD = match args.first().and_then(|s| s.parse().ok()) {
        Some(p) if p > 0 => p,
        _ => {
            eprintln!("usage: ls-ports <pid>");
            return 2;
        }
    };
    let exe = query_process_exe(pid).unwrap_or_default();
    let listeners: Vec<String> = collect_tcp_listeners()
        .into_iter()
        .filter(|r| r.pid == pid)
        .map(|r| r.name)
        .collect();
    let listeners_json = listeners.iter().map(|n| json_escape(n)).collect::<Vec<_>>().join(",");
    println!("{{\"pid\":{},\"exe\":{},\"listeners\":[{}]}}", pid, json_escape(&exe), listeners_json);
    0
}

fn cmd_ps_list() -> i32 {
    let mut pids = vec![0u32; 4096];
    let mut needed: DWORD = 0;
    unsafe {
        if K32EnumProcesses(pids.as_mut_ptr(), (pids.len() * size_of::<DWORD>()) as DWORD, &mut needed) == FALSE {
            eprintln!("K32EnumProcesses failed: {}", GetLastError());
            return 1;
        }
        let mut count = (needed as usize) / size_of::<DWORD>();
        if count >= pids.len() {
            pids.resize(16384, 0);
            if K32EnumProcesses(pids.as_mut_ptr(), (pids.len() * size_of::<DWORD>()) as DWORD, &mut needed) != FALSE {
                count = ((needed as usize) / size_of::<DWORD>()).min(pids.len());
            }
        }
        pids.truncate(count);
    }

    let mut entries = Vec::new();
    for pid in pids {
        if pid == 0 {
            continue;
        }
        let exe = query_process_exe(pid).unwrap_or_default();
        let cmd = query_process_cmdline(pid).unwrap_or_else(|| exe.clone());
        if !exe.is_empty() || !cmd.is_empty() {
            entries.push(format!(
                "{{\"pid\":{},\"exe\":{},\"cmd\":{}}}",
                pid,
                json_escape(&exe),
                json_escape(&cmd)
            ));
        }
    }
    println!("[{}]", entries.join(","));
    0
}

fn read_ver_string(block: &[u8], lang_codepage: &str, key: &str) -> String {
    let sub = to_wide(&format!("\\StringFileInfo\\{}\\{}", lang_codepage, key));
    let mut ptr: *mut c_void = null_mut();
    let mut len: u32 = 0;
    unsafe {
        if VerQueryValueW(block.as_ptr() as *const c_void, sub.as_ptr(), &mut ptr, &mut len) != FALSE
            && !ptr.is_null()
            && len > 0
        {
            let slice = std::slice::from_raw_parts(ptr as *const u16, len as usize);
            let trimmed = slice.split(|&c| c == 0).next().unwrap_or(&[]);
            return String::from_utf16_lossy(trimmed);
        }
    }
    String::new()
}

fn cmd_exe_info(args: &[String]) -> i32 {
    let path = match args.first() {
        Some(p) => p,
        None => {
            eprintln!("usage: exe-info <path>");
            return 2;
        }
    };
    let path_w = to_wide(path);
    let mut file_version = String::new();
    let mut product_name = String::new();
    let mut company_name = String::new();

    unsafe {
        let mut dummy: DWORD = 0;
        let ver_size = GetFileVersionInfoSizeW(path_w.as_ptr(), &mut dummy);
        if ver_size > 0 {
            let mut block = vec![0u8; ver_size as usize];
            if GetFileVersionInfoW(path_w.as_ptr(), 0, ver_size, block.as_mut_ptr() as *mut c_void) != FALSE {
                // Try Translation table first
                let mut trans_ptr: *mut c_void = null_mut();
                let mut trans_len: u32 = 0;
                let trans_sub = to_wide("\\VarFileInfo\\Translation");
                let mut lang_cp = String::from("040904B0");
                if VerQueryValueW(block.as_ptr() as *const c_void, trans_sub.as_ptr(), &mut trans_ptr, &mut trans_len) != FALSE
                    && !trans_ptr.is_null()
                    && trans_len >= 4
                {
                    let words = std::slice::from_raw_parts(trans_ptr as *const WORD, 2);
                    lang_cp = format!("{:04X}{:04X}", words[0], words[1]);
                }
                file_version = read_ver_string(&block, &lang_cp, "FileVersion");
                product_name = read_ver_string(&block, &lang_cp, "ProductName");
                company_name = read_ver_string(&block, &lang_cp, "CompanyName");

                if file_version.is_empty() {
                    let root_sub = to_wide("\\");
                    let mut fixed_ptr: *mut c_void = null_mut();
                    let mut fixed_len: u32 = 0;
                    if VerQueryValueW(block.as_ptr() as *const c_void, root_sub.as_ptr(), &mut fixed_ptr, &mut fixed_len) != FALSE
                        && !fixed_ptr.is_null()
                        && (fixed_len as usize) >= size_of::<VS_FIXEDFILEINFO>()
                    {
                        let info = &*(fixed_ptr as *const VS_FIXEDFILEINFO);
                        file_version = format!(
                            "{}.{}.{}",
                            (info.dwFileVersionMS >> 16) & 0xFFFF,
                            info.dwFileVersionMS & 0xFFFF,
                            (info.dwFileVersionLS >> 16) & 0xFFFF
                        );
                    }
                }
            }
        }
    }

    // WinVerifyTrust check
    let mut action_guid = GUID {
        Data1: 0x00AAC56B,
        Data2: 0xCD44,
        Data3: 0x11d0,
        Data4: [0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE],
    };
    let mut file_info = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as DWORD,
        pcwszFilePath: path_w.as_ptr(),
        hFile: null_mut(),
        pgKnownSubject: null_mut(),
    };
    let mut trust_data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as DWORD,
        pPolicyCallbackData: null_mut(),
        pSIPClientData: null_mut(),
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        pFile: &mut file_info,
        dwStateAction: WTD_STATEACTION_VERIFY,
        hWVTStateData: null_mut(),
        pwszURLReference: null_mut(),
        dwProvFlags: 0,
        dwUIContext: 0,
        pSignatureSettings: null_mut(),
    };
    let trust_status = unsafe { WinVerifyTrust(null_mut(), &mut action_guid, &mut trust_data as *mut _ as *mut c_void) };
    trust_data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        WinVerifyTrust(null_mut(), &mut action_guid, &mut trust_data as *mut _ as *mut c_void);
    }

    println!(
        "{{\"fileVersion\":{},\"productName\":{},\"companyName\":{},\"signed\":{},\"trustStatus\":{}}}",
        json_escape(&file_version),
        json_escape(&product_name),
        json_escape(&company_name),
        if trust_status == 0 { "true" } else { "false" },
        trust_status
    );
    0
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let code = match args.first().map(|s| s.as_str()) {
        Some("cred") => cmd_cred(&args[1..]),
        Some("trash") => cmd_trash(&args[1..]),
        Some("tcp-owners") => cmd_tcp_owners(&args[1..]),
        Some("ls-ports") => cmd_ls_ports(&args[1..]),
        Some("ps-list") => cmd_ps_list(),
        Some("exe-info") => cmd_exe_info(&args[1..]),
        _ => {
            eprintln!("usage: gb-win-helper <cred|trash|tcp-owners|ls-ports|ps-list|exe-info> ...");
            2
        }
    };
    std::process::exit(code);
}
