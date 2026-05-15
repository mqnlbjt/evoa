# OIL 嵌入式石油数据采集系统 - 最优架构设计

## 一、项目概述

- **项目路径**: /home/wyq/data/OIL/A620_RaspberryPI/
- **目标硬件**: 树莓派 / A620板
- **编程语言**: C++ (C++11/14)
- **核心通信**: 串口通信 + System V 消息队列
- **架构风格**: 多线程 + 消息驱动（非epoll，非pub/sub）

---

## 二、目录结构设计

```
A620_RaspberryPI/
├── build/                          # 编译输出目录
├── config/                         # 配置文件
│   ├── system.conf                 # 系统配置
│   ├── serial_ports.conf           # 串口配置
│   └── fields/                     # 油田专属配置
│       ├── tuha.conf
│       ├── qinghai.conf
│       └── factory2.conf
├── docs/                           # 文档
├── include/                        # 公共头文件
│   ├── common/                     # 通用工具
│   │   ├── types.h                 # 类型定义
│   │   ├── logger.h                # 日志系统
│   │   ├── config_parser.h         # 配置解析
│   │   └── utils.h                 # 工具函数
│   ├── core/                       # 核心框架
│   │   ├── message_queue.h         # 消息队列封装
│   │   ├── message_dispatcher.h    # 统一消息分发器
│   │   ├── thread_base.h           # 线程基类
│   │   ├── state_machine.h         # 状态机
│   │   └── timer_manager.h         # 定时器管理
│   ├── protocol/                   # 协议层
│   │   ├── modbus.h                # Modbus协议
│   │   ├── frame_parser.h          # 帧解析器
│   │   └── data_codec.h            # 数据编解码
│   ├── driver/                     # 驱动层
│   │   ├── serial_driver.h         # 串口驱动
│   │   ├── gpio_driver.h           # GPIO驱动
│   │   └── network_driver.h        # 网络驱动
│   └── module/                     # 业务模块接口
│       ├── collector.h             # 数据采集接口
│       ├── reporter.h              # 数据上报接口
│       └── field_adapter.h         # 油田适配器接口
├── src/                            # 源代码
│   ├── common/                     # 通用实现
│   │   ├── logger.cpp
│   │   ├── config_parser.cpp
│   │   └── utils.cpp
│   ├── core/                       # 核心框架实现
│   │   ├── message_queue.cpp
│   │   ├── message_dispatcher.cpp
│   │   ├── thread_base.cpp
│   │   ├── state_machine.cpp
│   │   └── timer_manager.cpp
│   ├── protocol/                   # 协议实现
│   │   ├── modbus_rtu.cpp
│   │   ├── modbus_tcp.cpp
│   │   ├── frame_parser.cpp
│   │   └── data_codec.cpp
│   ├── driver/                     # 驱动实现
│   │   ├── serial_driver.cpp
│   │   ├── gpio_driver.cpp
│   │   └── network_driver.cpp
│   ├── module/                     # 业务模块实现
│   │   ├── collector/
│   │   │   ├── pump_collector.cpp  # 抽油机数据采集
│   │   │   ├── well_collector.cpp  # 油井数据采集
│   │   │   └── sensor_collector.cpp# 传感器数据采集
│   │   ├── reporter/
│   │   │   ├── data_reporter.cpp   # 数据上报
│   │   │   └── alarm_reporter.cpp  # 告警上报
│   │   └── field/                  # 油田适配模块
│   │       ├── field_factory.h     # 油田工厂
│   │       ├── tuha_adapter.cpp    # 吐哈油田
│   │       ├── qinghai_adapter.cpp # 青海油田
│   │       └── factory2_adapter.cpp# 二厂
│   ├── thread/                     # 线程模块
│   │   ├── main_thread.cpp         # 主线程
│   │   ├── serial_thread.cpp       # 串口通信线程
│   │   ├── collect_thread.cpp      # 数据采集线程
│   │   ├── process_thread.cpp      # 数据处理线程
│   │   ├── report_thread.cpp       # 数据上报线程
│   │   └── monitor_thread.cpp      # 监控线程
│   └── main.cpp                    # 程序入口
├── Makefile                        # 主Makefile
├── make.sh                         # 编译脚本
└── README.md
```

---

## 三、核心架构分层

```
┌─────────────────────────────────────────────────────────┐
│                    应用层 (Application)                   │
│   main.cpp → 系统初始化、启动各线程、主循环               │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                    线程层 (Thread Layer)                  │
│   serial_thread / collect_thread / process_thread        │
│   report_thread / monitor_thread                         │
│   → 各线程独立运行，通过消息队列通信                      │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                    模块层 (Module Layer)                  │
│   collector / reporter / field_adapter                   │
│   → 业务逻辑实现，油田差异化适配                          │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                    核心层 (Core Layer)                    │
│   message_dispatcher / state_machine / timer_manager     │
│   → 统一消息分发、状态管理、定时任务                      │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                    协议层 (Protocol Layer)                │
│   modbus_rtu / modbus_tcp / frame_parser / data_codec    │
│   → 协议解析、数据编解码                                 │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                    驱动层 (Driver Layer)                  │
│   serial_driver / gpio_driver / network_driver           │
│   → 硬件抽象，串口/GPIO/网络操作                         │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│                    通用层 (Common Layer)                  │
│   logger / config_parser / types / utils                 │
│   → 日志、配置、类型定义、工具函数                        │
└─────────────────────────────────────────────────────────┘
```

---

## 四、核心组件设计

### 4.1 统一消息分发器 (MessageDispatcher)

```cpp
// include/core/message_dispatcher.h
#pragma once
#include <functional>
#include <map>
#include <queue>
#include <mutex>
#include <condition_variable>

// 消息类型定义
enum class MsgType : uint32_t {
    MSG_SERIAL_DATA     = 0x0001,  // 串口数据
    MSG_COLLECT_RESULT  = 0x0002,  // 采集结果
    MSG_PROCESS_RESULT  = 0x0003,  // 处理结果
    MSG_REPORT_CMD      = 0x0004,  // 上报命令
    MSG_ALARM           = 0x0005,  // 告警
    MSG_HEARTBEAT       = 0x0006,  // 心跳
    MSG_CONFIG_UPDATE   = 0x0007,  // 配置更新
    MSG_SHUTDOWN        = 0x00FF,  // 关机
};

// 消息结构
struct Message {
    MsgType type;
    uint32_t source_id;     // 源线程ID
    uint32_t dest_id;       // 目标线程ID (0=广播)
    uint64_t timestamp;
    std::vector<uint8_t> payload;
};

// 消息处理器类型
using MsgHandler = std::function<void(const Message&)>;

class MessageDispatcher {
public:
    static MessageDispatcher& instance();
    
    // 注册消息处理器
    void register_handler(MsgType type, uint32_t thread_id, MsgHandler handler);
    
    // 发送消息
    bool send_message(const Message& msg);
    
    // 广播消息
    void broadcast(const Message& msg);
    
    // 启动分发线程
    void start();
    void stop();
    
private:
    MessageDispatcher();
    ~MessageDispatcher();
    
    void dispatch_loop();
    
    std::mutex mutex_;
    std::condition_variable cv_;
    std::queue<Message> msg_queue_;
    
    // type -> (thread_id -> handler)
    std::map<MsgType, std::map<uint32_t, MsgHandler>> handlers_;
    
    std::atomic<bool> running_{false};
    std::thread dispatch_thread_;
};
```

### 4.2 线程基类 (ThreadBase)

```cpp
// include/core/thread_base.h
#pragma once
#include <thread>
#include <atomic>
#include <string>
#include "state_machine.h"
#include "message_dispatcher.h"

class ThreadBase {
public:
    explicit ThreadBase(const std::string& name, uint32_t thread_id);
    virtual ~ThreadBase();
    
    // 启动/停止线程
    bool start();
    void stop();
    void request_stop();  // 优雅停止，替代pthread_cancel
    
    bool is_running() const { return running_.load(); }
    uint32_t get_id() const { return thread_id_; }
    const std::string& get_name() const { return name_; }
    
protected:
    // 子类实现
    virtual bool on_init() = 0;           // 初始化
    virtual void on_run() = 0;            // 主循环
    virtual void on_stop() = 0;           // 清理
    virtual void on_message(const Message& msg);  // 消息处理
    
    // 发送消息
    void send_to(uint32_t dest_id, MsgType type, const std::vector<uint8_t>& data);
    void broadcast(MsgType type, const std::vector<uint8_t>& data);
    
    std::string name_;
    uint32_t thread_id_;
    std::atomic<bool> running_{false};
    std::atomic<bool> stop_requested_{false};
    StateMachine state_machine_;
    
private:
    void thread_func();
    std::thread thread_;
};
```

### 4.3 状态机 (StateMachine)

```cpp
// include/core/state_machine.h
#pragma once
#include <functional>
#include <map>
#include <string>

enum class ThreadState {
    IDLE,       // 空闲
    INITING,    // 初始化中
    RUNNING,    // 运行中
    PAUSED,     // 暂停
    STOPPING,   // 停止中
    ERROR       // 错误
};

using StateHandler = std::function<void()>;

class StateMachine {
public:
    StateMachine();
    
    void set_state(ThreadState state);
    ThreadState get_state() const { return current_state_; }
    
    // 注册状态进入/退出回调
    void on_enter(ThreadState state, StateHandler handler);
    void on_exit(ThreadState state, StateHandler handler);
    
    bool is_running() const { return current_state_ == ThreadState::RUNNING; }
    bool should_stop() const;
    
private:
    ThreadState current_state_{ThreadState::IDLE};
    std::map<ThreadState, StateHandler> enter_handlers_;
    std::map<ThreadState, StateHandler> exit_handlers_;
};
```

### 4.4 串口驱动 (SerialDriver)

```cpp
// include/driver/serial_driver.h
#pragma once
#include <string>
#include <functional>
#include <thread>
#include <atomic>

struct SerialConfig {
    std::string port;           // /dev/ttyS0, /dev/ttyUSB0
    int baudrate{9600};         // 波特率
    int databits{8};            // 数据位
    int stopbits{1};            // 停止位
    char parity{'N'};           // 校验位 N/E/O
    int timeout_ms{1000};       // 超时时间
};

using DataCallback = std::function<void(const uint8_t* data, size_t len)>;

class SerialDriver {
public:
    SerialDriver();
    ~SerialDriver();
    
    // 打开/关闭串口
    bool open(const SerialConfig& config);
    void close();
    bool is_open() const { return fd_ >= 0; }
    
    // 读写数据
    int write(const uint8_t* data, size_t len);
    int read(uint8_t* buffer, size_t max_len, int timeout_ms = -1);
    
    // 异步读取（在独立线程中）
    void start_async_read(DataCallback callback);
    void stop_async_read();
    
    // 串口控制
    bool set_baudrate(int baudrate);
    bool flush();
    
private:
    void async_read_loop();
    
    int fd_{-1};
    SerialConfig config_;
    std::atomic<bool> async_running_{false};
    std::thread async_thread_;
    DataCallback data_callback_;
};
```

### 4.5 Modbus协议 (Modbus)

```cpp
// include/protocol/modbus.h
#pragma once
#include <vector>
#include <cstdint>
#include <functional>

// Modbus功能码
enum class ModbusFunc : uint8_t {
    READ_COILS          = 0x01,
    READ_DISCRETE       = 0x02,
    READ_HOLDING        = 0x03,
    READ_INPUT          = 0x04,
    WRITE_SINGLE_COIL   = 0x05,
    WRITE_SINGLE_REG    = 0x06,
    WRITE_MULTI_COILS   = 0x0F,
    WRITE_MULTI_REGS    = 0x10,
};

// Modbus请求
struct ModbusRequest {
    uint8_t slave_addr;
    ModbusFunc function;
    uint16_t start_addr;
    uint16_t quantity;
    std::vector<uint16_t> write_data;  // 写操作时的数据
};

// Modbus响应
struct ModbusResponse {
    bool success;
    uint8_t exception_code;           // 异常码
    std::vector<uint8_t> raw_data;    // 原始数据
    std::vector<uint16_t> reg_values; // 寄存器值
};

class ModbusMaster {
public:
    ModbusMaster();
    ~ModbusMaster();
    
    // 绑定串口驱动
    void bind_serial(SerialDriver* serial);
    
    // 发送请求并等待响应
    ModbusResponse send_request(const ModbusRequest& req, int timeout_ms = 1000);
    
    // 便捷读取函数
    ModbusResponse read_holding_registers(uint8_t slave, uint16_t start, uint16_t count);
    ModbusResponse read_input_registers(uint8_t slave, uint16_t start, uint16_t count);
    ModbusResponse write_single_register(uint8_t slave, uint16_t addr, uint16_t value);
    
private:
    // 构建请求帧
    std::vector<uint8_t> build_request(const ModbusRequest& req);
    
    // 解析响应帧
    ModbusResponse parse_response(const uint8_t* data, size_t len);
    
    // CRC校验
    uint16_t calculate_crc(const uint8_t* data, size_t len);
    
    SerialDriver* serial_{nullptr};
    std::mutex mutex_;  // 保证请求-响应原子性
};
```

### 4.6 数据采集器 (Collector)

```cpp
// include/module/collector.h
#pragma once
#include "core/thread_base.h"
#include "protocol/modbus.h"

// 采集点定义
struct CollectPoint {
    uint32_t point_id;
    std::string name;
    uint8_t slave_addr;
    uint16_t reg_addr;
    uint16_t reg_count;
    float scale;           // 缩放系数
    float offset;          // 偏移量
    std::string unit;      // 单位
};

// 采集数据
struct CollectData {
    uint32_t point_id;
    uint64_t timestamp;
    float value;
    bool valid;
};

class Collector : public ThreadBase {
public:
    Collector(const std::string& name, uint32_t id);
    virtual ~Collector();
    
    // 加载采集点配置
    bool load_points(const std::string& config_file);
    
protected:
    // 实现ThreadBase接口
    bool on_init() override;
    void on_run() override;
    void on_stop() override;
    
    // 采集单个点
    CollectData collect_point(const CollectPoint& point);
    
    // 批量采集
    std::vector<CollectData> collect_batch(const std::vector<CollectPoint>& points);
    
    ModbusMaster modbus_;
    std::vector<CollectPoint> points_;
    int collect_interval_ms_{5000};  // 采集间隔
};
```

### 4.7 油田适配器 (FieldAdapter)

```cpp
// include/module/field_adapter.h
#pragma once
#include <string>
#include <memory>
#include <map>

// 油田类型
enum class FieldType {
    TUHA,       // 吐哈
    QINGHAI,    // 青海
    FACTORY2,   // 二厂
    // 可扩展...
};

// 油田适配器接口
class FieldAdapter {
public:
    virtual ~FieldAdapter() = default;
    
    // 获取油田名称
    virtual std::string get_name() const = 0;
    
    // 获取采集点配置文件路径
    virtual std::string get_points_config() const = 0;
    
    // 获取上报协议配置
    virtual std::string get_report_config() const = 0;
    
    // 数据格式转换（油田特有）
    virtual bool convert_data(const CollectData& input, void* output) = 0;
    
    // 获取油田特有参数
    virtual std::string get_param(const std::string& key) const = 0;
};

// 油田工厂
class FieldFactory {
public:
    static std::unique_ptr<FieldAdapter> create(FieldType type);
    static std::unique_ptr<FieldAdapter> create(const std::string& type_name);
    
    static void register_adapter(FieldType type, 
        std::function<std::unique_ptr<FieldAdapter>()> creator);
    
private:
    static std::map<FieldType, std::function<std::unique_ptr<FieldAdapter>()>> creators_;
};
```

### 4.8 串口通信线程 (SerialThread)

```cpp
// src/thread/serial_thread.cpp
#include "thread/serial_thread.h"
#include "core/message_dispatcher.h"

SerialThread::SerialThread(uint32_t id) 
    : ThreadBase("SerialThread", id) {
}

bool SerialThread::on_init() {
    // 加载串口配置
    SerialConfig config;
    // ... 从配置文件加载
    
    if (!serial_.open(config)) {
        LOG_ERROR("Failed to open serial port: {}", config.port);
        return false;
    }
    
    // 启动异步读取
    serial_.start_async_read([this](const uint8_t* data, size_t len) {
        // 收到数据，发送消息给处理线程
        std::vector<uint8_t> payload(data, data + len);
        send_to(THREAD_PROCESS, MsgType::MSG_SERIAL_DATA, payload);
    });
    
    // 注册消息处理
    MessageDispatcher::instance().register_handler(
        MsgType::MSG_REPORT_CMD, thread_id_,
        [this](const Message& msg) {
            // 收到上报命令，通过串口发送
            serial_.write(msg.payload.data(), msg.payload.size());
        }
    );
    
    return true;
}

void SerialThread::on_run() {
    // 主循环：检查状态、处理超时等
    while (!state_machine_.should_stop()) {
        // 可以用eventfd替代sleep提升响应性
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        
        // 检查连接状态
        if (!serial_.is_open()) {
            LOG_WARN("Serial disconnected, attempting reconnect...");
            // 尝试重连...
        }
    }
}

void SerialThread::on_stop() {
    serial_.stop_async_read();
    serial_.close();
}
```

---

## 五、线程间通信设计

### 5.1 消息流图

```
┌─────────────┐    MSG_SERIAL_DATA    ┌─────────────┐
│   Serial    │ ────────────────────→ │   Process   │
│   Thread    │                       │   Thread    │
└─────────────┘                       └─────────────┘
                                            │
                                            ↓ MSG_COLLECT_RESULT
                                      ┌─────────────┐
                                      │   Report    │
                                      │   Thread    │
                                      └─────────────┘
                                            │
                                            ↓ MSG_REPORT_CMD
                                      ┌─────────────┐
                                      │   Serial    │
                                      │   Thread    │
                                      └─────────────┘

┌─────────────┐    MSG_HEARTBEAT      ┌─────────────┐
│   Monitor   │ ←──────────────────── │  All Threads│
│   Thread    │                       │             │
└─────────────┘                       └─────────────┘
```

### 5.2 使用eventfd提升响应性

```cpp
// 在ThreadBase中使用eventfd
#include <sys/eventfd.h>

class ThreadBase {
protected:
    int wakeup_fd_;  // eventfd用于唤醒阻塞
    
    bool init_wakeup() {
        wakeup_fd_ = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
        return wakeup_fd_ >= 0;
    }
    
    void wakeup() {
        uint64_t val = 1;
        write(wakeup_fd_, &val, sizeof(val));
    }
    
    bool wait_for_event(int timeout_ms) {
        struct pollfd pfd = { wakeup_fd_, POLLIN, 0 };
        int ret = poll(&pfd, 1, timeout_ms);
        if (ret > 0 && (pfd.revents & POLLIN)) {
            uint64_t val;
            read(wakeup_fd_, &val, sizeof(val));
            return true;
        }
        return false;
    }
};
```

---

## 六、条件编译设计（油田差异化）

### 6.1 Makefile配置

```makefile
# Makefile

# 油田选择
FIELD ?= tuha

# 根据油田定义宏
ifeq ($(FIELD), tuha)
    CFLAGS += -DFIELD_TUHA
else ifeq ($(FIELD), qinghai)
    CFLAGS += -DFIELD_QINGHAI
else ifeq ($(FIELD), factory2)
    CFLAGS += -DFIELD_FACTORY2
endif

# 平台选择
PLATFORM ?= raspberry
ifeq ($(PLATFORM), raspberry)
    CFLAGS += -DPLATFORM_RASPBERRY
else ifeq ($(PLATFORM), a620)
    CFLAGS += -DPLATFORM_A620
endif

# 编译目标
TARGET = oil_collector_$(FIELD)

SRCS = $(wildcard src/*.cpp src/**/*.cpp)
OBJS = $(SRCS:.cpp=.o)

$(TARGET): $(OBJS)
	$(CXX) $(CFLAGS) -o $@ $^ $(LDFLAGS)

clean:
	rm -f $(OBJS) $(TARGET)
```

### 6.2 编译脚本

```bash
#!/bin/bash
# make.sh

FIELD=${1:-tuha}
PLATFORM=${2:-raspberry}

echo "Building for field: $FIELD, platform: $PLATFORM"

make clean
make FIELD=$FIELD PLATFORM=$PLATFORM -j4

echo "Build complete: oil_collector_$FIELD"
```

---

## 七、系统启动流程

```cpp
// src/main.cpp
#include "core/message_dispatcher.h"
#include "thread/serial_thread.h"
#include "thread/collect_thread.h"
#include "thread/process_thread.h"
#include "thread/report_thread.h"
#include "thread/monitor_thread.h"
#include "module/field_adapter.h"

int main(int argc, char* argv[]) {
    // 1. 解析命令行参数
    std::string field_type = "tuha";
    if (argc > 1) field_type = argv[1];
    
    // 2. 初始化日志系统
    Logger::init("logs/oil_collector.log");
    LOG_INFO("=== OIL Collector Starting ===");
    LOG_INFO("Field type: {}", field_type);
    
    // 3. 加载油田配置
    auto field = FieldFactory::create(field_type);
    if (!field) {
        LOG_ERROR("Unknown field type: {}", field_type);
        return -1;
    }
    
    // 4. 创建线程
    std::vector<std::unique_ptr<ThreadBase>> threads;
    threads.push_back(std::make_unique<SerialThread>(THREAD_SERIAL));
    threads.push_back(std::make_unique<CollectThread>(THREAD_COLLECT));
    threads.push_back(std::make_unique<ProcessThread>(THREAD_PROCESS));
    threads.push_back(std::make_unique<ReportThread>(THREAD_REPORT));
    threads.push_back(std::make_unique<MonitorThread>(THREAD_MONITOR));
    
    // 5. 启动消息分发器
    MessageDispatcher::instance().start();
    
    // 6. 启动所有线程
    for (auto& t : threads) {
        if (!t->start()) {
            LOG_ERROR("Failed to start thread: {}", t->get_name());
            return -1;
        }
        LOG_INFO("Thread started: {}", t->get_name());
    }
    
    // 7. 主循环等待退出信号
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    
    while (!g_exit_flag) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
    
    // 8. 优雅关闭
    LOG_INFO("Shutting down...");
    for (auto& t : threads) {
        t->request_stop();
    }
    for (auto& t : threads) {
        t->stop();
    }
    MessageDispatcher::instance().stop();
    
    LOG_INFO("=== OIL Collector Stopped ===");
    return 0;
}
```

---

## 八、优化建议总结

| 优化项 | 描述 | 优先级 |
|--------|------|--------|
| 统一消息分发器 | 替代直接的消息队列调用，降低模块扩展成本 | 高 |
| 状态机管理 | 替代pthread_cancel，提高线程安全性 | 高 |
| eventfd唤醒 | 替代sleep轮询，提升主循环响应性 | 中 |
| 串口异步读取 | 使用独立线程异步读取，避免阻塞主线程 | 高 |
| 配置热更新 | 支持运行时更新配置，无需重启 | 低 |
| 看门狗监控 | 监控线程健康状态，自动重启异常线程 | 中 |
| 日志分级 | 支持动态调整日志级别 | 低 |

---

## 九、编译与运行

```bash
# 编译吐哈油田版本
./make.sh tuha raspberry

# 编译青海油田版本
./make.sh qinghai raspberry

# 运行
./oil_collector_tuha tuha
```

---

## 十一、全局变量治理方案

### 11.1 问题分析

当前项目中存在大量全局变量，主要分布在以下场景：

| 问题 | 表现 | 风险 |
|------|------|------|
| 隐式依赖 | 模块间通过全局变量"悄悄"通信，调用链不可追踪 | 新人难以理解，调试困难 |
| 线程安全 | 多线程同时读写全局变量，缺乏统一保护 | 数据竞争、段错误、数据不一致 |
| 初始化顺序 | 全局变量构造/析构顺序不确定（C++ static initialization order fiasco） | 启动时随机崩溃 |
| 可测试性 | 模块强耦合于全局状态，无法独立单元测试 | 质量保障困难 |
| 条件编译污染 | 不同油田的全局变量混在一起，靠 `#ifdef` 管理 | 编译产物臃肿，宏地狱 |

### 11.2 全局变量分类与治理策略

项目中常见的全局变量大致可归为以下五类，每一类有对应的治理手段：

```
全局变量
├── A. 配置类 (config)
│   └── → 治理: ConfigManager 单例
├── B. 状态类 (state)
│   └── → 治理: 收归到所属线程/模块的成员变量
├── C. 线程句柄/ID类 (thread handles)
│   └── → 治理: ThreadManager 统一管理
├── D. 通信对象类 (msg queues, semaphores)
│   └── → 治理: MessageDispatcher 封装
└── E. 信号/退出标志类 (flags)
    └── → 治理: AppContext 单例 + atomic
```

---

#### A. 配置类全局变量 → ConfigManager 单例

**改造前（典型问题代码）：**
```cpp
// ❌ 到处散落的全局配置变量
gchar g_szDBPath[256];
gchar g_szDeviceID[64];
int g_nCollectInterval = 5;
int g_nReportInterval  = 60;
float g_fLatitude  = 0.0f;
float g_fLongitude = 0.0f;
char g_szWellNo[32];
```

**改造后：**
```cpp
// include/common/config_manager.h
#pragma once
#include <string>
#include <mutex>
#include <unordered_map>
#include <atomic>

class ConfigManager {
public:
    // 线程安全单例
    static ConfigManager& instance() {
        static ConfigManager inst;  // C++11 保证线程安全的局部静态
        return inst;
    }

    // 加载配置文件
    bool load(const std::string& config_path);

    // 类型安全的getter
    std::string get_string(const std::string& key, const std::string& default_val = "") const;
    int         get_int(const std::string& key, int default_val = 0) const;
    float       get_float(const std::string& key, float default_val = 0.0f) const;
    bool        get_bool(const std::string& key, bool default_val = false) const;

    // 运行时动态更新（支持热更新）
    void set(const std::string& key, const std::string& value);

    // 重新加载
    bool reload();

private:
    ConfigManager() = default;
    ~ConfigManager() = default;
    ConfigManager(const ConfigManager&) = delete;
    ConfigManager& operator=(const ConfigManager&) = delete;

    mutable std::mutex mutex_;
    std::unordered_map<std::string, std::string> values_;
    std::string config_path_;
};

// 使用示例
// 之前: g_nCollectInterval
// 之后: ConfigManager::instance().get_int("collect_interval", 5)
```

---

#### B. 状态类全局变量 → 收归成员变量

**改造前：**
```cpp
// ❌ 全局状态变量，任何线程都能读写
gint g_nPumpStatus = 0;         // 抽油机状态
gfloat g_fPumpStroke = 0.0f;    // 冲程
gfloat g_fPumpFreq = 0.0f;      // 冲次
gint g_nCollectCount = 0;       // 采集计数
gboolean g_bConnected = FALSE;  // 连接状态
```

**改造后：**
```cpp
// 每个状态变量收归到拥有它的模块/线程中
// include/module/collector/pump_state.h
#pragma once
#include <mutex>
#include <cstdint>

// 专门的状态容器：封装数据 + 互斥锁
class PumpState {
public:
    struct Data {
        int    status{0};
        float  stroke{0.0f};
        float  freq{0.0f};
        int    collect_count{0};
        bool   connected{false};
    };

    // 线程安全读取
    Data snapshot() const {
        std::lock_guard<std::mutex> lk(mutex_);
        return data_;
    }

    // 线程安全写入
    void update_status(int s) {
        std::lock_guard<std::mutex> lk(mutex_);
        data_.status = s;
    }
    void update_stroke(float v) {
        std::lock_guard<std::mutex> lk(mutex_);
        data_.stroke = v;
    }
    void update_freq(float v) {
        std::lock_guard<std::mutex> lk(mutex_);
        data_.freq = v;
    }
    void increment_count() {
        std::lock_guard<std::mutex> lk(mutex_);
        data_.collect_count++;
    }
    void set_connected(bool c) {
        std::lock_guard<std::mutex> lk(mutex_);
        data_.connected = c;
    }

private:
    mutable std::mutex mutex_;
    Data data_;
};

// 使用示例
// class PumpCollector : public ThreadBase {
//     PumpState pump_state_;   // 成员变量，而非全局
// };
```

---

#### C. 线程句柄/ID类 → ThreadManager

**改造前：**
```cpp
// ❌ 线程ID散落全局
pthread_t g_tidSerial;
pthread_t g_tidCollect;
pthread_t g_tidProcess;
pthread_t g_tidReport;
int g_nSerialThreadRunning = 0;
int g_nCollectThreadRunning = 0;
```

**改造后：**
```cpp
// include/core/thread_manager.h
#pragma once
#include "thread_base.h"
#include <memory>
#include <vector>
#include <unordered_map>
#include <string>

class ThreadManager {
public:
    static ThreadManager& instance() {
        static ThreadManager inst;
        return inst;
    }

    // 注册线程
    bool register_thread(std::unique_ptr<ThreadBase> thread);

    // 按名称获取
    ThreadBase* get_thread(const std::string& name);

    // 启动所有
    bool start_all();

    // 优雅停止所有（替代pthread_cancel）
    void stop_all();

    // 查询状态
    bool is_all_running() const;
    void print_status() const;  // 打印所有线程状态

private:
    ThreadManager() = default;
    std::vector<std::unique_ptr<ThreadBase>> threads_;
    std::unordered_map<std::string, size_t> name_index_;
};

// 使用示例
// ThreadManager::instance().get_thread("SerialThread")->is_running();
```

---

#### D. 通信对象类（消息队列/信号量）→ MessageDispatcher

**改造前：**
```cpp
// ❌ 全局消息队列ID
int g_msgid_main_to_serial;
int g_msgid_serial_to_process;
int g_msgid_process_to_report;
int g_msgid_alarm;
sem_t g_semCollect;
sem_t g_semReport;
```

**改造后：**

这些全部收归到 `MessageDispatcher` 内部（已在 4.1 节设计）。对外只暴露类型化的 `send_message()` / `register_handler()` 接口，线程不再直接接触底层 IPC 对象。

```cpp
// 线程内部不再持有任何 msgid / sem_t
// 通过 MessageDispatcher 的统一接口通信

void ProcessThread::on_run() {
    // 注册消息回调即可，无需知道底层队列ID
    MessageDispatcher::instance().register_handler(
        MsgType::MSG_SERIAL_DATA, thread_id_,
        [this](const Message& msg) {
            process_serial_data(msg.payload);
        }
    );
}
```

---

#### E. 信号/退出标志类 → AppContext 单例

**改造前：**
```cpp
// ❌ 到处声明的全局退出标志
volatile int g_exit_flag = 0;
volatile int g_restart_flag = 0;
volatile int g_config_reload_flag = 0;
sig_atomic_t g_sigint_received = 0;
```

**改造后：**
```cpp
// include/core/app_context.h
#pragma once
#include <atomic>
#include <csignal>

class AppContext {
public:
    static AppContext& instance() {
        static AppContext inst;
        return inst;
    }

    // 退出控制
    void request_exit() { exit_flag_.store(true); }
    bool should_exit() const { return exit_flag_.load(); }

    // 重启控制
    void request_restart() { restart_flag_.store(true); }
    bool should_restart() const { return restart_flag_.exchange(false); }

    // 配置重载
    void request_config_reload() { config_reload_flag_.store(true); }
    bool should_reload_config() { return config_reload_flag_.exchange(false); }

    // 信号处理
    static void signal_handler(int sig) {
        if (sig == SIGINT || sig == SIGTERM) {
            instance().request_exit();
        } else if (sig == SIGHUP) {
            instance().request_config_reload();
        }
    }

    // 注册信号处理器
    void install_signal_handlers() {
        std::signal(SIGINT,  signal_handler);
        std::signal(SIGTERM, signal_handler);
        std::signal(SIGHUP,  signal_handler);
    }

private:
    AppContext() = default;
    std::atomic<bool> exit_flag_{false};
    std::atomic<bool> restart_flag_{false};
    std::atomic<bool> config_reload_flag_{false};
};

// 使用示例
// while (!AppContext::instance().should_exit()) { ... }
```

