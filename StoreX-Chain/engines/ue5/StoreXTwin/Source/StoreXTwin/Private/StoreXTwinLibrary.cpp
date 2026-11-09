// SPDX-FileCopyrightText: 2026 Glacieerr
// SPDX-License-Identifier: MIT
#include "StoreXTwinLibrary.h"

#include "StoreXTwinSettings.h"

FVector UStoreXTwinLibrary::TwinToWorld(float X, float Z)
{
	const UStoreXTwinSettings* S = GetDefault<UStoreXTwinSettings>();
	const float Sign = S->bMirrorY ? -1.f : 1.f;
	return S->Origin + FVector(X * S->Scale, Sign * Z * S->Scale, 0.f);
}

FVector2D UStoreXTwinLibrary::WorldToTwin(const FVector& World)
{
	const UStoreXTwinSettings* S = GetDefault<UStoreXTwinSettings>();
	const FVector L = World - S->Origin;
	const float Sign = S->bMirrorY ? -1.f : 1.f;
	return FVector2D(L.X / S->Scale, Sign * L.Y / S->Scale);
}

FString UStoreXTwinLibrary::ClockText(float TwinSeconds)
{
	const int32 M = FMath::Clamp(FMath::FloorToInt(TwinSeconds / 60.f), 0, 24 * 60 - 1);
	return FString::Printf(TEXT("%02d:%02d"), M / 60, M % 60);
}
