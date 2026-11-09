// SPDX-FileCopyrightText: 2026 Glacieerr
// SPDX-License-Identifier: MIT
#include "StoreXTwinSubsystem.h"

#include "Dom/JsonObject.h"
#include "IWebSocket.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "StoreXTwinSettings.h"
#include "WebSocketsModule.h"

DEFINE_LOG_CATEGORY_STATIC(LogStoreXTwin, Log, All);

void UStoreXTwinSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	if (GetDefault<UStoreXTwinSettings>()->bAutoConnect)
	{
		Connect();
	}
}

void UStoreXTwinSubsystem::Deinitialize()
{
	Disconnect();
	Super::Deinitialize();
}

void UStoreXTwinSubsystem::Connect()
{
	if (Socket.IsValid() && Socket->IsConnected())
	{
		return;
	}
	if (!FModuleManager::Get().IsModuleLoaded(TEXT("WebSockets")))
	{
		FModuleManager::Get().LoadModule(TEXT("WebSockets"));
	}
	const FString Url = GetDefault<UStoreXTwinSettings>()->ServerUrl;
	Socket = FWebSocketsModule::Get().CreateWebSocket(Url);
	Socket->OnConnected().AddLambda([Url]() { UE_LOG(LogStoreXTwin, Log, TEXT("已连上孪生服务 %s"), *Url); });
	Socket->OnConnectionError().AddLambda([Url](const FString& Error) { UE_LOG(LogStoreXTwin, Warning, TEXT("连不上孪生服务 %s：%s"), *Url, *Error); });
	Socket->OnClosed().AddLambda([](int32 Code, const FString& Reason, bool bClean) { UE_LOG(LogStoreXTwin, Log, TEXT("孪生服务断开（%d %s）"), Code, *Reason); });
	Socket->OnMessage().AddUObject(this, &UStoreXTwinSubsystem::HandleMessage);
	Socket->Connect();
}

void UStoreXTwinSubsystem::Disconnect()
{
	if (Socket.IsValid())
	{
		Socket->Close();
		Socket.Reset();
	}
}

bool UStoreXTwinSubsystem::IsConnected() const
{
	return Socket.IsValid() && Socket->IsConnected();
}

void UStoreXTwinSubsystem::Send(const TSharedRef<FJsonObject>& Obj)
{
	if (!IsConnected())
	{
		UE_LOG(LogStoreXTwin, Warning, TEXT("没有连上孪生服务，消息没发出去"));
		return;
	}
	FString Out;
	const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
	FJsonSerializer::Serialize(Obj, Writer);
	Socket->Send(Out);
}

void UStoreXTwinSubsystem::Approve(const FString& Key, const FString& Option)
{
	const TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetStringField(TEXT("type"), TEXT("approve"));
	Obj->SetStringField(TEXT("key"), Key);
	if (!Option.IsEmpty())
	{
		Obj->SetStringField(TEXT("option"), Option);
	}
	Send(Obj);
}

void UStoreXTwinSubsystem::Reject(const FString& Key)
{
	const TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetStringField(TEXT("type"), TEXT("reject"));
	Obj->SetStringField(TEXT("key"), Key);
	Send(Obj);
}

void UStoreXTwinSubsystem::SendCommandJson(const FString& CommandJson)
{
	TSharedPtr<FJsonObject> Cmd;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(CommandJson);
	if (!FJsonSerializer::Deserialize(Reader, Cmd) || !Cmd.IsValid())
	{
		UE_LOG(LogStoreXTwin, Warning, TEXT("指令不是合法的 JSON：%s"), *CommandJson);
		return;
	}
	const TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetStringField(TEXT("type"), TEXT("command"));
	Obj->SetObjectField(TEXT("cmd"), Cmd);
	Send(Obj);
}

void UStoreXTwinSubsystem::SetSpeed(float MinutesPerSecond, bool bPaused)
{
	const TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetStringField(TEXT("type"), TEXT("control"));
	Obj->SetNumberField(TEXT("speed"), MinutesPerSecond);
	Obj->SetBoolField(TEXT("paused"), bPaused);
	Send(Obj);
}

void UStoreXTwinSubsystem::HandleMessage(const FString& Text)
{
	TSharedPtr<FJsonObject> Obj;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
	if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid())
	{
		return;
	}
	const FString Type = Obj->GetStringField(TEXT("type"));
	if (Type == TEXT("hello"))
	{
		const TSharedPtr<FJsonObject>* State = nullptr;
		if (Obj->TryGetObjectField(TEXT("state"), State))
		{
			const TSharedPtr<FJsonObject> Inner = *State;
			Obj = Inner;
		}
	}
	if (Type == TEXT("tick") || Type == TEXT("hello"))
	{
		TwinSeconds = static_cast<float>(Obj->GetNumberField(TEXT("t")));
		const TSharedPtr<FJsonObject>* K = nullptr;
		if (Obj->TryGetObjectField(TEXT("kpi"), K))
		{
			Kpi.LateMin = static_cast<float>((*K)->GetNumberField(TEXT("lateMin")));
			Kpi.HotMin = static_cast<float>((*K)->GetNumberField(TEXT("hotMin")));
			Kpi.ShortMin = static_cast<float>((*K)->GetNumberField(TEXT("shortMin")));
			Kpi.DoorWaitMin = static_cast<float>((*K)->GetNumberField(TEXT("doorWaitMin")));
			Kpi.DockWaitMin = static_cast<float>((*K)->GetNumberField(TEXT("dockWaitMin")));
			Kpi.Cost = static_cast<float>((*K)->GetNumberField(TEXT("cost")));
		}
		const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
		if (Obj->TryGetArrayField(TEXT("vehicles"), List))
		{
			ReadVehicles(*List);
		}
		OnTick.Broadcast(TwinSeconds, Current, Kpi);
	}
	else if (Type == TEXT("cards"))
	{
		const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
		if (Obj->TryGetArrayField(TEXT("cards"), List))
		{
			ReadCards(*List);
		}
	}
	else if (Type == TEXT("msgs"))
	{
		const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
		if (Obj->TryGetArrayField(TEXT("msgs"), List))
		{
			FString Out;
			const TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
			FJsonSerializer::Serialize(*List, Writer);
			OnMessages.Broadcast(Out);
		}
	}
	else if (Type == TEXT("reply"))
	{
		bool bOk = false;
		Obj->TryGetBoolField(TEXT("ok"), bOk);
		if (!bOk)
		{
			FString Error;
			Obj->TryGetStringField(TEXT("error"), Error);
			UE_LOG(LogStoreXTwin, Warning, TEXT("孪生服务没有接受：%s"), *Error);
		}
	}
}

void UStoreXTwinSubsystem::ReadVehicles(const TArray<TSharedPtr<FJsonValue>>& List)
{
	const UStoreXTwinSettings* S = GetDefault<UStoreXTwinSettings>();
	Previous = MoveTemp(Current);
	Current.Reset(List.Num());
	for (const TSharedPtr<FJsonValue>& V : List)
	{
		const TSharedPtr<FJsonObject> O = V->AsObject();
		if (!O.IsValid())
		{
			continue;
		}
		FStoreXVehicle Out;
		Out.Vid = static_cast<int32>(O->GetNumberField(TEXT("vid")));
		O->TryGetStringField(TEXT("id"), Out.Id);
		O->TryGetStringField(TEXT("kind"), Out.Kind);
		O->TryGetStringField(TEXT("label"), Out.Label);
		O->TryGetStringField(TEXT("state"), Out.State);
		O->TryGetStringField(TEXT("act"), Out.Act);
		O->TryGetBoolField(TEXT("reversing"), Out.bReversing);
		// 沙盘坐标（米，x 向东、z 向南）→ 虚幻（厘米，X 向东、Y 向南、Z 向上）；朝向直接是 Yaw
		const double X = O->GetNumberField(TEXT("x"));
		const double Z = O->GetNumberField(TEXT("z"));
		const double Sign = S->bMirrorY ? -1.0 : 1.0;
		Out.Location = S->Origin + FVector(X * S->Scale, Sign * Z * S->Scale, 0.0);
		Out.Yaw = static_cast<float>(Sign * O->GetNumberField(TEXT("heading")));
		Out.DelayMin = static_cast<float>(O->GetNumberField(TEXT("delayMin")));
		double Temp = 0.0;
		if (O->TryGetNumberField(TEXT("temp"), Temp))
		{
			Out.bHasTemp = true;
			Out.Temp = static_cast<float>(Temp);
		}
		Current.Add(MoveTemp(Out));
	}
	LastTickSeconds = FPlatformTime::Seconds();
}

void UStoreXTwinSubsystem::ReadCards(const TArray<TSharedPtr<FJsonValue>>& List)
{
	for (const TSharedPtr<FJsonValue>& V : List)
	{
		const TSharedPtr<FJsonObject> O = V->AsObject();
		if (!O.IsValid())
		{
			continue;
		}
		FStoreXCard C;
		O->TryGetStringField(TEXT("key"), C.Key);
		O->TryGetStringField(TEXT("kind"), C.Kind);
		O->TryGetStringField(TEXT("clock"), C.Clock);
		O->TryGetStringField(TEXT("title"), C.Title);
		O->TryGetStringField(TEXT("text"), C.Text);
		O->TryGetStringField(TEXT("status"), C.Status);
		O->TryGetStringField(TEXT("best"), C.Best);
		O->TryGetStringField(TEXT("chosen"), C.Chosen);
		C.Time = static_cast<float>(O->GetNumberField(TEXT("t")));
		const TArray<TSharedPtr<FJsonValue>>* Opts = nullptr;
		if (O->TryGetArrayField(TEXT("options"), Opts))
		{
			for (const TSharedPtr<FJsonValue>& OV : *Opts)
			{
				const TSharedPtr<FJsonObject> OO = OV->AsObject();
				if (!OO.IsValid())
				{
					continue;
				}
				FStoreXOption Op;
				OO->TryGetStringField(TEXT("key"), Op.Key);
				OO->TryGetStringField(TEXT("label"), Op.Label);
				OO->TryGetStringField(TEXT("note"), Op.Note);
				Op.Late = static_cast<float>(OO->GetNumberField(TEXT("late")));
				Op.Hot = static_cast<float>(OO->GetNumberField(TEXT("hot")));
				Op.Short = static_cast<float>(OO->GetNumberField(TEXT("short")));
				Op.Cost = static_cast<float>(OO->GetNumberField(TEXT("cost")));
				OO->TryGetBoolField(TEXT("auto"), Op.bAuto);
				OO->TryGetBoolField(TEXT("hasCommands"), Op.bHasCommands);
				C.Options.Add(MoveTemp(Op));
			}
		}
		const int32 Existing = Cards.IndexOfByPredicate([&C](const FStoreXCard& X) { return X.Key == C.Key; });
		if (Existing != INDEX_NONE)
		{
			Cards[Existing] = C;
		}
		else
		{
			Cards.Add(C);
		}
	}
	OnCards.Broadcast(Cards);
}
